'use strict';
const {PublicKey,Connection}=require('@solana/web3.js');
const bs58=require('bs58');
const P=require('./pump.cjs'),W=require('./wire.cjs'),Policy=require('./policy.cjs'),DB=require('./db.cjs');
const PARSER='rebound-execution-v2.1';
const TOKEN=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const PUMP=P.SDK.PUMP_PROGRAM_ID.toBase58(),AMM=P.SDK.PUMP_AMM_PROGRAM_ID.toBase58();
const EVENT_CPI=Buffer.from('e445a52e51cb9a1d','hex');
const stringify=Policy.stable;
function plain(v){if(v&&typeof v==='object'){if(typeof v.toBase58==='function')return v.toBase58();if(v.constructor?.name==='BN')return v.toString(10);if(Array.isArray(v))return v.map(plain);return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,plain(x)]));}return v;}
function eventDecoder(program,data){
 if(data.length<16||!data.subarray(0,8).equals(EVENT_CPI))return null;
 const disc=data.subarray(8,16),body=data.subarray(16);
 const names=program===PUMP?[['TradeEvent','decodeTradeEventBc'],['CreateEvent','decodeCreateEventBc'],['DistributeCreatorFeesEvent','decodeDistributeCreatorFeesEvent'],['CollectCreatorFeeEvent','decodeCollectCreatorFeeEventBc']]:program===AMM?[['BuyEvent','decodeBuyEventAmm'],['SellEvent','decodeSellEventAmm'],['CreatePoolEvent','decodeCreatePoolEventAmm']]:[];
 for(const[name,method]of names)if(W.hash('event:'+name).subarray(0,8).equals(disc))return{name,data:plain(P.sdk[method](body))};
 return null;
}
function trace(tx){
 const out=[],message=tx.transaction.message,inner=new Map((tx.meta.innerInstructions||[]).map(i=>[i.index,i.instructions]));
 for(let root=0;root<message.instructions.length;root++){
  const top={...message.instructions[root],path:String(root),depth:1,parent:null};out.push(top);const stack=[top];
  for(const[ordinal,instruction]of (inner.get(root)||[]).entries()){
   const depth=instruction.stackHeight;if(!Number.isInteger(depth)||depth<2||depth>stack.length+1)throw Error('Incomplete CPI execution depth');
   const parent=stack[depth-2];if(!parent)throw Error('Unknown CPI parent');
   const row={...instruction,path:root+'/'+ordinal,depth,parent};stack.length=depth-1;stack.push(row);out.push(row);
  }
 }return out.map((x,order)=>({...x,order}));
}
const address=x=>typeof x==='string'?x:x?.pubkey;
function parseTransaction(tx,{slot,time,transactionIndex,coins,ownership=new Map()}){
 const events=[],holds=[];if(!tx.meta||tx.meta.err)return{events,holds,ownership};
 const keys=tx.transaction.message.accountKeys.map(address),signature=tx.transaction.signatures[0],coinMap=new Map(coins.map(c=>[c.mint,c]));
 const known=new Map(ownership),post=new Map();
 for(const b of tx.meta.preTokenBalances||[])if(b.owner)known.set(keys[b.accountIndex],{mint:b.mint,owner:b.owner,amount:b.uiTokenAmount.amount});
 for(const b of tx.meta.postTokenBalances||[])post.set(keys[b.accountIndex],b);
 let instructions;try{instructions=trace(tx);}catch(e){return{events,holds:coins.map(c=>({mint:c.mint,reason:e.message,signature})),ownership};}
 const emit=(ins,kind,mint,owner,data,eventIndex=0)=>{const id=W.hash(signature,ins.path,String(eventIndex),mint||'').toString('hex');events.push({id,mint,signature,path:ins.path,eventIndex,slot,time,transactionIndex,order:ins.order,kind,owner,data,rawDigest:W.hash(stringify(ins)).toString('hex'),parser:PARSER});return id;};
 for(const ins of instructions){
  const program=address(ins.programId),parsed=ins.parsed,info=parsed?.info;
  if(program===PUMP||program===AMM){
   if(program===AMM&&ins.data){const disc=Buffer.from(bs58.decode(ins.data)).subarray(0,8);const knownNames=['buy','buy_exact_quote_in','sell','sell_exact_quote_out','extend_account','deposit','withdraw','create_pool','transfer_creator_fees_to_pump_v2'];if(!disc.equals(EVENT_CPI)&&!knownNames.some(n=>disc.equals(W.hash('global:'+n).subarray(0,8))))for(const c of coins)if(ins.accounts?.map(address).includes(P.SDK.canonicalPumpPoolPda(W.pk(c.mint)).toBase58()))emit(ins,'market_invalidation',c.mint,null,{reason:'unmodeled_pool_configuration_change'});}
   try{
    const event=ins.data?eventDecoder(program,Buffer.from(bs58.decode(ins.data))):null;
    if(event){
     // Anchor event CPI must be a self-call under the actual market program.
     if(!ins.parent||address(ins.parent.programId)!==program)throw Error('Event not emitted by verified self CPI');
     const e=event.data;
     const mint=e.mint||e.baseMint||coins.find(c=>P.SDK.canonicalPumpPoolPda(W.pk(c.mint)).toBase58()===e.pool||event.name==='CollectCreatorFeeEvent'&&c.intake===e.creator)?.mint;
     if(!mint||!coinMap.has(mint))continue;const coin=coinMap.get(mint);
     if(event.name==='TradeEvent'||event.name==='BuyEvent'||event.name==='SellEvent'){
      const buy=event.name==='BuyEvent'||event.name==='TradeEvent'&&e.isBuy;
      const root=ins.parent;const direct=root.depth===1;
      const creator=e.creator||e.coinCreator,canonical=program===PUMP||e.pool===P.SDK.canonicalPumpPoolPda(W.pk(mint)).toBase58();
      const user=e.user;
      if(!buy){emit(ins,'sale',mint,user,{event:e,marketProgram:program,route:root.path});continue;}
      // BN.toJSON is hexadecimal; normalize SDK BN fields before stringify
      // in eventDecoder, never interpret a BN hex string as decimal.
      const creatorFee=String(e.creatorFee??e.coinCreatorFee??0),quantity=String(e.tokenAmount??e.baseAmountOut??0);
      const quote=String(e.quoteAmount??e.solAmount??e.quoteAmountIn??0);
      const fees=program===PUMP?Policy.sum([e.fee||0,creatorFee,e.buybackFee||0,e.cashback||0,e.holderRewards||0]):Policy.sum([e.lpFee||0,e.protocolFee||0,creatorFee,e.buybackFee||0,e.cashbackFee||0,e.holderRewards||0]);
      emit(ins,'purchase_candidate',mint,user,{event:e,success:true,finalized:true,complete:true,provenanceComplete:direct,canonical,creator,expectedCreator:coin.current_creator,quoteAsset:e.quoteMint&&![PublicKey.default.toBase58(),'So11111111111111111111111111111111111111112'].includes(e.quoteMint)?'unsupported':'native-SOL',venue:program===PUMP?'pump-curve':canonical?'pump-canonical-amm':'side-pool',quantity,actualQuote:quote,creatorFee,unavoidableFees:String(fees),route:root.path});
     }else if(event.name==='DistributeCreatorFeesEvent')emit(ins,'creator_distribution',mint,null,{event:e,destination:coin.intake,sharing:coin.sharing_config});
     else if(event.name==='CollectCreatorFeeEvent')emit(ins,'initial_creator_collection',mint,null,{event:e,route:ins.parent.path});
     else if(event.name==='CreatePoolEvent')emit(ins,'graduation',mint,null,{event:e});
     else emit(ins,'create',mint,e.user,{event:e});
    }
   }catch(e){for(const c of coins)holds.push({mint:c.mint,signature,path:ins.path,reason:'protocol_parser_error:'+e.message});}
  }
  if(TOKEN.has(program)&&parsed){
   const type=parsed.type;
   if(['initializeAccount','initializeAccount2','initializeAccount3'].includes(type)){if(info.account&&info.owner&&info.mint){known.set(info.account,{mint:info.mint,owner:info.owner,amount:'0'});if(coinMap.has(info.mint))emit(ins,'owner_initialized',info.mint,info.owner,{account:info.account});}continue;}
   if(['transfer','transferChecked','transferCheckedWithFee'].includes(type)){
    const source=known.get(info.source),destination=known.get(info.destination),mint=info.mint||source?.mint||post.get(info.source)?.mint||post.get(info.destination)?.mint;
    const amount=String(info.amount??info.tokenAmount?.amount??'0');if(Policy.int(amount)===0n)continue;
    if(mint==='So11111111111111111111111111111111111111112')emit(ins,'quote_transfer',null,source?.owner,{source:info.source,destination:info.destination,from:source?.owner,to:destination?.owner,amount,asset:'wrapped-SOL'});
    if(source)known.set(info.source,{...source,amount:String(BigInt(source.amount||0)-BigInt(amount))});if(destination)known.set(info.destination,{...destination,amount:String(BigInt(destination.amount||0)+BigInt(amount))});
    if(!coinMap.has(mint))continue;
    if(!source?.owner){holds.push({mint,signature,path:ins.path,reason:'source_owner_unresolved'});continue;}
    const coin=coinMap.get(mint),marketOwners=new Set([P.SDK.bondingCurvePda(W.pk(mint)).toBase58(),P.SDK.canonicalPumpPoolPda(W.pk(mint)).toBase58()]);
    if(source.owner===destination?.owner){emit(ins,'same_owner_transfer',mint,source.owner,{source:info.source,destination:info.destination,amount});continue;}
    // Pool inventory delivery is not an exit by an investor. Unknown routing
    // owners are never blanket-exempt; unsupported transient paths are held.
    const migrationOwner=P.SDK.pumpPoolAuthorityPda(W.pk(mint)).toBase58();
    if(source.owner===migrationOwner&&ins.parent&&address(ins.parent.programId)===AMM&&ins.parent.parent&&address(ins.parent.parent.programId)===PUMP){emit(ins,'migration_transfer',mint,null,{source:info.source,destination:info.destination,amount});continue;}
    if(marketOwners.has(source.owner)){emit(ins,'market_delivery',mint,destination?.owner||null,{source:info.source,destination:info.destination,amount});continue;}
    if(!destination?.owner){holds.push({mint,wallet:source.owner,signature,path:ins.path,reason:'destination_owner_unresolved'});continue;}
    emit(ins,'transfer_exit',mint,source.owner,{source:info.source,destination:info.destination,to:destination.owner,amount,delegate:info.authority||info.multisigAuthority});
    emit(ins,'incoming_transfer',mint,destination.owner,{source:info.source,from:source.owner,amount},1);
   }else if(type==='closeAccount'){
    const source=known.get(info.account);if(source?.mint==='So11111111111111111111111111111111111111112'&&ins.parent&&address(ins.parent.programId)===AMM&&ins.parent.data&&Buffer.from(bs58.decode(ins.parent.data)).subarray(0,8).equals(Buffer.from('01214eb921432c5c','hex'))){for(const c of coins){for(const creator of [c.intake,c.sharing_config]){const authority=P.SDK.ammCreatorVaultPda(W.pk(creator)).toBase58();if(source.owner===authority&&info.destination===authority)emit(ins,'creator_unwrap',c.mint,null,{source:info.account,authority,creator,amount:source.amount,route:ins.parent.path,vault:P.SDK.creatorVaultPda(W.pk(creator)).toBase58(),asset:'wrapped-SOL'});}}}
    if(source)known.set(info.account,{...source,amount:'0'});
   }else if(['burn','burnChecked'].includes(type)){
    const owner=known.get(info.account),mint=info.mint||owner?.mint;if(coinMap.has(mint)){if(!owner)holds.push({mint,signature,reason:'burn_owner_unknown'});else if(Policy.int(info.amount??info.tokenAmount?.amount??0)>0n)emit(ins,'burn',mint,owner.owner,{account:info.account,amount:info.amount??info.tokenAmount.amount});}
   }else if(type==='setAuthority'&&['accountOwner','AccountOwner'].includes(info.authorityType)){
    const old=known.get(info.account);if(old&&coinMap.has(old.mint)&&old.owner!==info.newAuthority){emit(ins,'owner_change',old.mint,old.owner,{account:info.account,nextOwner:info.newAuthority});known.set(info.account,{...old,owner:info.newAuthority});}
   }
  }else if(TOKEN.has(program)&&!parsed){
   const touched=(ins.accounts||[]).map(address).some(k=>coinMap.has(known.get(k)?.mint)||coinMap.has(post.get(k)?.mint));
   if(touched)for(const c of coins)holds.push({mint:c.mint,signature,path:ins.path,reason:'unsupported_token_instruction'});
  }
  if(program==='11111111111111111111111111111111'&&parsed?.type==='transfer'){
   if(!Number.isSafeInteger(info.lamports))holds.push({signature,reason:'unsafe_native_amount'});
   else emit(ins,'funding_transfer',null,info.source,{from:info.source,to:info.destination,amount:String(info.lamports),asset:'native-SOL'});
  }
 }
 // Reconcile historical authority, even where a token account has no net delta.
 for(const[account,b]of post){const k=known.get(account);if(coinMap.has(b.mint)&&(!k||k.owner!==b.owner))holds.push({mint:b.mint,signature,account,reason:'unreconciled_token_authority'});}
 for(const c of coins){const pool=P.SDK.canonicalPumpPoolPda(W.pk(c.mint)).toBase58(),b=[...post.values()].find(b=>b.owner===pool&&b.mint===c.mint),q=[...post.values()].find(b=>b.owner===pool&&b.mint==='So11111111111111111111111111111111111111112');if(b&&q)emit({path:'post/pool',order:instructions.length},'pool_balances',c.mint,null,{base:b.uiTokenAmount.amount,quote:q.uiTokenAmount.amount,market:pool});}
 return{events,holds,ownership:known};
}
class Rpc{
 constructor(url=process.env.SOLANA_RPC_URL){if(!url)throw Error('SOLANA_RPC_URL required');this.url=url;this.id=0;}
 async call(method,params=[]){const response=await fetch(this.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++this.id,method,params}),signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('RPC HTTP '+response.status);const r=await response.json();if(r.error)throw Error('RPC '+method+' error '+r.error.code);return r.result;}
}
async function indexBatch(db,rpc,{name='finalized-blocks',from,limit=32,genesis,coins}){
 const head=await rpc.call('getSlot',[{commitment:'finalized'}]);const checkpoint=(await db.query('SELECT * FROM reward_checkpoints WHERE name=$1',[name])).rows[0];
 const start=checkpoint?Number(checkpoint.through_slot)+1:from;if(!Number.isSafeInteger(start)||start<0)throw Error('Provable index start slot required');
 const end=Math.min(head,start+limit-1);if(end<start)return{through:head};
 const slots=await rpc.call('getBlocks',[start,end,{commitment:'finalized'}]);if(!Array.isArray(slots)||slots.some((s,i)=>s<start||s>end||i&&s<=slots[i-1]))throw Error('Invalid finalized block coverage');
 const owners=new Map((await db.query('SELECT address,mint,owner FROM reward_token_ownership WHERE end_event IS NULL')).rows.map(r=>[r.address,r]));let ownership=owners;
 let latestTime=Number(checkpoint?.through_time||0),digest=checkpoint?.digest||'',incident=null;
 for(const slot of slots){
  const block=await rpc.call('getBlock',[slot,{encoding:'jsonParsed',transactionDetails:'full',rewards:false,maxSupportedTransactionVersion:0,commitment:'finalized'}]);
  if(!block||!Number.isSafeInteger(block.blockTime)||!Array.isArray(block.transactions))throw Error('Missing finalized block '+slot);
  const rawDigest=W.hash(stringify(block)).toString('hex');latestTime=block.blockTime;
  await DB.transaction(db,async tx=>{
   const prior=(await tx.query('SELECT digest FROM reward_raw_blocks WHERE genesis=$1 AND slot=$2',[genesis,slot])).rows[0];if(prior){if(prior.digest!==rawDigest)throw Error('Finalized block changed');return;}
   await tx.query('INSERT INTO reward_raw_blocks(genesis,slot,blockhash,parent_slot,block_time,payload,digest,parser_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[genesis,slot,block.blockhash,block.parentSlot,block.blockTime,stringify(block),rawDigest,PARSER]);
   for(const[index,transaction]of block.transactions.entries()){
    const parsed=parseTransaction(transaction,{slot,time:block.blockTime,transactionIndex:index,coins,ownership});ownership=parsed.ownership;
    for(const e of parsed.events){
     await tx.query('INSERT INTO reward_events(id,mint,signature,instruction_path,event_index,slot,transaction_index,execution_order,kind,owner,data,raw_digest,parser_version,finalized) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true) ON CONFLICT DO NOTHING',[e.id,e.mint,e.signature,e.path,e.eventIndex,e.slot,e.transactionIndex,e.order,e.kind,e.owner,stringify({...e.data,time:e.time}),e.rawDigest,PARSER]);
     if(['sale','transfer_exit','burn','owner_change'].includes(e.kind)&&e.owner){await tx.query('INSERT INTO reward_disqualifications(mint,wallet,event,slot,kind) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[e.mint,e.owner,e.id,e.slot,e.kind]);await tx.query('UPDATE reward_purchase_lots SET continuously_held=false WHERE mint=$1 AND wallet=$2',[e.mint,e.owner]);}
     if(e.kind==='owner_initialized'||e.kind==='owner_change'){
      if(e.kind==='owner_change')await tx.query('UPDATE reward_token_ownership SET end_event=$2,end_slot=$3 WHERE address=$1 AND end_event IS NULL',[e.data.account,e.id,e.slot]);
      await tx.query('INSERT INTO reward_token_ownership(address,mint,owner,start_event,start_slot) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[e.data.account,e.mint,e.kind==='owner_change'?e.data.nextOwner:e.owner,e.id,e.slot]);
     }
    }
    if(parsed.holds.length){await DB.audit(tx,'indexing_hold',{slot,holds:parsed.holds});const global=parsed.holds.filter(h=>!h.wallet);if(global.length)incident={slot,holds:global};for(const hold of global)if(hold.mint)await tx.query("UPDATE reward_coins SET blocked_reason=$2 WHERE mint=$1",[hold.mint,hold.reason]);}
   }
  });digest=W.hash(digest,rawDigest).toString('hex');
 }
 // Skipped slots are attested by getBlocks, missing produced blocks are errors.
 await db.query('INSERT INTO reward_checkpoints(name,through_slot,through_time,start_slot,complete,parser_version,digest,incident) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(name) DO UPDATE SET through_slot=EXCLUDED.through_slot,through_time=EXCLUDED.through_time,complete=EXCLUDED.complete,digest=EXCLUDED.digest,incident=COALESCE(reward_checkpoints.incident,EXCLUDED.incident),updated_at=now()',[name,end,latestTime,checkpoint?.start_slot||start,!incident&&!checkpoint?.incident,PARSER,digest,incident?stringify(incident):null]);
 return{through:end,head,complete:!incident&&!checkpoint?.incident,incident};
}
module.exports={PARSER,plain,eventDecoder,trace,parseTransaction,Rpc,indexBatch};
