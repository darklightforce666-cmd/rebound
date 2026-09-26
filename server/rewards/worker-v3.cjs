'use strict';
// REBOUND V3 worker (spec §5.3). One restartable Node process; roles run as independent loops:
//   indexer   — incremental mint-scoped finalized history → reward_events; coverage checkpoints;
//               SOL/USD samples (on-chain Pyth account); verified market heartbeats; dev-wallet
//               funding reconciliation; public token projections.
//   scheduler — cycle-v3 ticks for every active V3 coin.
// Progress is durable in Supabase; a crash loses nothing (leases expire, the next run resumes).
// Netlify functions never run these loops; Supabase Edge Functions are not used as an indexer.
const crypto=require('node:crypto');
const {Connection,PublicKey}=require('@solana/web3.js');
const DB=require('./db.cjs'),P3=require('./policy-v3.cjs'),H=require('./history-v3.cjs'),I=require('./indexer.cjs'),Pump=require('./pump.cjs');
const FX=require('./sol-usd.cjs'),F=require('./primary-funding.cjs'),FS=require('./funding-store.cjs'),C=require('./cycle-v3.cjs'),V=require('./verifier-v3.cjs');
const Logs=require('./logs.cjs'),Signer=require('./signer.cjs'),W3=require('./wire-v3.cjs'),{stable}=require('./policy.cjs');
const R=require('./receipts-v3.cjs'),BB=require('./buyback-v3.cjs'),Admin=require('./admin-v3.cjs');
const b=x=>BigInt(x);

// ---------------- history ingestion ----------------
async function ingest({db,rpc},coin){
 const mint=coin.mint,m=H.marketAddresses(mint),head=await rpc.call('getSlot',[{commitment:'finalized'}]);
 for(const [address,role] of [[m.mint,'mint'],[m.curve,'curve'],[m.pool,'pool']])
  await db.query('INSERT INTO reward_history_cursors(mint,address,role,discovered_slot) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[mint,address,role,head]);
 const incomplete=[],seen=new Set();let newEvents=0,newTx=0;
 const queue=(await db.query("SELECT * FROM reward_history_cursors WHERE mint=$1 AND role<>'funding_wallet' ORDER BY CASE role WHEN 'mint' THEN 0 WHEN 'curve' THEN 1 WHEN 'pool' THEN 2 ELSE 3 END,address",[mint])).rows;
 while(queue.length){
  const cur=queue.shift();if(seen.has(cur.address))continue;seen.add(cur.address);
  const r=await H.signaturesFor(rpc,cur.address,{until:cur.newest_signature||null});if(!r.complete)incomplete.push({address:cur.address,reason:r.reason});
  let gap=!r.complete;   // a cursor never advances past a transaction that was not ingested
  const sigs=r.signatures.filter(s=>!s.err).reverse();       // oldest first
  for(const s of sigs){
   if((await db.query('SELECT 1 FROM reward_events WHERE signature=$1 LIMIT 1',[s.signature])).rows.length){continue;}
   const tx=await rpc.call('getTransaction',[s.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:H.TX_VERSION}]);
   if(!tx){incomplete.push({signature:s.signature,reason:'transaction_unavailable'});gap=true;break;}
   let index=H.reportedIndex(tx,s);
   if(index==null){const block=await rpc.call('getBlock',[tx.slot,{transactionDetails:'signatures',rewards:false,commitment:'finalized',maxSupportedTransactionVersion:H.TX_VERSION}]);index=(block?.signatures||[]).indexOf(s.signature);}if(index<0){incomplete.push({slot:tx.slot,reason:'in_block_order_unavailable'});gap=true;break;}
   const keys=tx.transaction.message.accountKeys.map(k=>typeof k==='string'?k:k.pubkey);
   for(const bal of [...(tx.meta?.preTokenBalances||[]),...(tx.meta?.postTokenBalances||[])])if(bal.mint===mint){
    const acct=keys[bal.accountIndex];if(!seen.has(acct)&&!queue.some(q=>q.address===acct)){
     const ins=await db.query("INSERT INTO reward_history_cursors(mint,address,role,discovered_slot) VALUES($1,$2,'token_account',$3) ON CONFLICT DO NOTHING RETURNING *",[mint,acct,tx.slot]);
     if(ins.rows[0])queue.push(ins.rows[0]);}
   }
   const parsed=I.parseTransaction(tx,{slot:tx.slot,time:tx.blockTime,transactionIndex:index,coins:[{mint,intake:coin.intake,sharing_config:coin.sharing_config,current_creator:null}]});
   await DB.transaction(db,async t=>{
    for(const e of parsed.events)await t.query('INSERT INTO reward_events(id,mint,signature,instruction_path,event_index,slot,transaction_index,execution_order,kind,owner,data,raw_digest,parser_version,finalized) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true) ON CONFLICT DO NOTHING',
     [e.id,e.mint,e.signature,e.path,e.eventIndex,e.slot,index,e.order,e.kind,e.owner,stable({...e.data,time:tx.blockTime}),e.rawDigest,I.PARSER]);
    if(parsed.holds.length)await t.query("INSERT INTO reward_audit(kind,mint,actor,evidence) VALUES('parser_hold',$1,'indexer',$2)",[mint,stable({signature:s.signature,holds:parsed.holds})]);
   });
   newEvents+=parsed.events.length;newTx++;
  }
  if(r.signatures.length&&!gap)await db.query('UPDATE reward_history_cursors SET newest_signature=$3,newest_slot=$4,updated_at=now() WHERE mint=$1 AND address=$2',[mint,cur.address,r.signatures[0].signature,r.signatures[0].slot]);
 }
 const complete=incomplete.length===0;
 await db.query(`INSERT INTO reward_checkpoints(name,through_slot,through_time,start_slot,complete,parser_version,digest,incident) VALUES($1,$2,$3,$2,$4,$5,'',$6)
  ON CONFLICT(name) DO UPDATE SET through_slot=CASE WHEN EXCLUDED.complete THEN EXCLUDED.through_slot ELSE reward_checkpoints.through_slot END,through_time=CASE WHEN EXCLUDED.complete THEN EXCLUDED.through_time ELSE reward_checkpoints.through_time END,complete=EXCLUDED.complete,incident=EXCLUDED.incident,updated_at=now()`,
  ['history:'+mint,head,await rpc.call('getBlockTime',[head]),complete,I.PARSER,complete?null:stable({incomplete:incomplete.slice(0,20)})]);
 return{head,newTx,newEvents,complete,incomplete};
}

// ---------------- evidence loaders for snapshots (scheduler and verifier use the same code) ----------------
function inputsLoader(db){
 return async(coinRow,cycle,cutoff,cutoffSlot)=>{
  const mint=coinRow.mint,m=H.marketAddresses(mint);
  const rows=(await db.query('SELECT * FROM reward_events WHERE mint=$1 AND slot<=$2 ORDER BY slot,transaction_index,execution_order,event_index',[mint,cutoffSlot])).rows;
  const events=rows.map(e=>({id:e.id,mint:e.mint,signature:e.signature,path:e.instruction_path,eventIndex:e.event_index,slot:Number(e.slot),transactionIndex:e.transaction_index,order:e.execution_order,kind:e.kind,owner:e.owner,data:e.data,time:Number(e.data.time)}));
  const cp=(await db.query('SELECT * FROM reward_checkpoints WHERE name=$1',['history:'+mint])).rows[0];
  const holds=(await db.query("SELECT evidence FROM reward_audit WHERE kind='parser_hold' AND mint=$1",[mint])).rows.flatMap(r=>r.evidence.holds||[]);
  const purchaseTimes=events.filter(e=>e.kind==='purchase_candidate').map(e=>e.time);
  const minT=purchaseTimes.length?Math.min(...purchaseTimes)-60:cutoff-120;
  const series=await FX.load(db,minT,cutoff);
  const excluded=new Set([m.curve,m.pool,m.poolAuthority,...[coinRow.intake,coinRow.treasury].filter(Boolean)]);
  const credits=(await db.query(`SELECT lc.lot_id,lc.credit_usd,a.state,c.cutoff_slot,a.cycle_id,a.leaf_index FROM reward_lot_credits lc JOIN reward_awards a USING(cycle_id,leaf_index) JOIN reward_cycles c ON c.id=a.cycle_id
   WHERE a.mint=$1 AND a.state IN ('reserved','paid','deferred_rent') AND c.cutoff_slot<$2`,[mint,cutoffSlot])).rows.map(r=>({slot:Number(r.cutoff_slot),lotId:r.lot_id,credit:b(r.credit_usd),state:r.state==='paid'?'paid':'reserved',award:r.cycle_id+':'+r.leaf_index}));
  const heartbeats=(await db.query('SELECT observed_at,quote_model,base_reserve,real_quote,virtual_quote,market FROM reward_price_observations WHERE mint=$1 AND heartbeat AND observed_at BETWEEN $2 AND $3',[mint,cutoff-120,cutoff])).rows
   .map(r=>({time:Number(r.observed_at),market:r.quote_model==='curve'?'pump-curve':'pump-amm:'+r.market,s18:r.quote_model==='curve'?P3.curveS18({virtualSolReserves:r.virtual_quote,virtualTokenReserves:r.base_reserve}):P3.ammS18({quoteReserve:r.real_quote,baseReserve:r.base_reserve})}));
  return{events,parserHolds:holds,coverage:{complete:!!cp?.complete,throughSlot:cp?Number(cp.through_slot):0},excluded,fx:FX.lookup(series),solSeries:series,heartbeats,credits};
 };
}

// ---------------- samplers ----------------
async function sampleSolUsd({db,connection}){const o=await FX.onchainAt(connection,process.env.PYTH_SOL_USD_ACCOUNT||FX.DEFAULT_FEED_ACCOUNT);if(o)await FX.persist(db,o);return o;}
async function heartbeat({db,connection},coin){
 const mint=new PublicKey(coin.mint),curve=Pump.SDK.bondingCurvePda(mint);const r=await connection.getAccountInfoAndContext(curve,'finalized');if(!r.value)return null;
 const bc=Pump.sdk.decodeBondingCurve(r.value);const time=await connection.getBlockTime(r.context.slot);
 if(!bc.complete){await db.query("INSERT INTO reward_price_observations(mint,slot,observed_at,market,base_reserve,real_quote,virtual_quote,evidence,quote_model,block_time,heartbeat) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'curve',$3,true) ON CONFLICT DO NOTHING",
  [coin.mint,r.context.slot,time,curve.toBase58(),bc.virtualTokenReserves.toString(),(bc.realQuoteReserves??bc.realSolReserves).toString(),(bc.virtualQuoteReserves??bc.virtualSolReserves).toString(),stable({source:'bonding_curve_account',slot:r.context.slot})]);return{market:'curve',slot:r.context.slot};}
 const pool=Pump.SDK.canonicalPumpPoolPda(mint);const p=await connection.getAccountInfo(pool,'finalized');if(!p)return null;
 const state=Pump.SDK.getPumpAmmProgram(connection).coder.accounts.decode('pool',p.data);
 const [base,quote]=await Promise.all([connection.getTokenAccountBalance(state.poolBaseTokenAccount,'finalized'),connection.getTokenAccountBalance(state.poolQuoteTokenAccount,'finalized')]);
 await db.query("INSERT INTO reward_price_observations(mint,slot,observed_at,market,base_reserve,real_quote,virtual_quote,evidence,quote_model,block_time,heartbeat) VALUES($1,$2,$3,$4,$5,$6,0,$7,'amm',$3,true) ON CONFLICT DO NOTHING",
  [coin.mint,base.context.slot,await connection.getBlockTime(base.context.slot),pool.toBase58(),base.value.amount,quote.value.amount,stable({source:'canonical_pool_balances'})]);return{market:'amm'};
}
async function reconcileFunding({db,rpc},coin){
 const fw=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[coin.mint])).rows[0];if(!fw||fw.opening_slot==null)return null;
 const r=await H.signaturesFor(rpc,fw.address,{until:fw.reconciled_signature||null});
 // Every REBOUND-built holder deposit (manual via intent, automatic via attempt context) is a liability move, not new funding.
 const intents=new Map((await db.query("SELECT a.signature,COALESCE(i.amount_lamports::text,a.context->>'amount') AS amount FROM reward_chain_attempts a LEFT JOIN reward_intents i ON i.id=a.intent_id WHERE a.kind='primary_funding' AND a.mint=$1",[coin.mint])).rows.filter(x=>x.amount!=null).map(x=>[x.signature,{kind:'holder_deposit',amount:x.amount}]));
 const classified=[];for(const s of r.signatures.slice().reverse()){const tx=await rpc.call('getTransaction',[s.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:H.TX_VERSION}]);if(tx)classified.push(F.classify(tx,fw.address,intents));}
 const out=await FS.applyWalletTransactions(db,{mint:coin.mint,wallet:fw.address,classified});
 if(r.signatures.length)await db.query('UPDATE reward_funding_wallets SET reconciled_signature=$2 WHERE id=$1',[fw.id,r.signatures[0].signature]);
 return{credits:out.credits.length,incidents:out.incidents.length};
}
// Holder funding (dev wallet, primary) credited at or before `cutoff` and not yet deposited.
async function primaryAwaiting(db,mint,cutoff){
 const a=(await db.query('SELECT holder_awaiting_transfer FROM reward_funding_accounts WHERE mint=$1',[mint])).rows[0];if(!a)return 0n;
 const late=(await db.query('SELECT COALESCE(sum(holder_lamports),0) s FROM reward_funding_credits WHERE mint=$1 AND block_time>$2',[mint,cutoff])).rows[0].s;
 const v=b(a.holder_awaiting_transfer)-b(String(late).split('.')[0]);return v>0n?v:0n;
}
async function projectToken({db,connection},coin){
 const info=await connection.getParsedAccountInfo(new PublicKey(coin.mint),'finalized');const m=info.value?.data?.parsed?.info;if(!m)return;
 const obs=(await db.query('SELECT * FROM reward_price_observations WHERE mint=$1 ORDER BY observed_at DESC LIMIT 1',[coin.mint])).rows[0];
 const sol=(await db.query('SELECT * FROM reward_sol_usd ORDER BY publish_time DESC LIMIT 1')).rows[0];
 let price=null,cap=null,at=null;
 if(obs&&sol){const s18=obs.quote_model==='curve'?P3.curveS18({virtualSolReserves:obs.virtual_quote,virtualTokenReserves:obs.base_reserve}):P3.ammS18({quoteReserve:obs.real_quote,baseReserve:obs.base_reserve});
  if(s18){const q18=s18*b(sol.price_usd_pico)/P3.LAMPORTS;price=q18/P3.E18;cap=b(m.supply)*q18/P3.E18;at=new Date(Number(obs.observed_at)*1000).toISOString();}}
 const status=coin.status==='active'?'active':coin.status;
 await db.query(`INSERT INTO reward_public_tokens(mint,namespace,kind,name,symbol,image_uri,creator_wallet,launch_time,decimals,supply_definition,supply_raw,price_usd_pico,price_updated_at,market_cap_usd_pico,market_cap_kind,price_source,reward_status,pinned,test)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'outstanding mint supply (burned units excluded)',$10,$11,$12,$13,'market_cap',$14,$15,$16,$17)
  ON CONFLICT(mint) DO UPDATE SET name=EXCLUDED.name,symbol=EXCLUDED.symbol,image_uri=EXCLUDED.image_uri,decimals=EXCLUDED.decimals,supply_raw=EXCLUDED.supply_raw,price_usd_pico=COALESCE(EXCLUDED.price_usd_pico,reward_public_tokens.price_usd_pico),
   price_updated_at=COALESCE(EXCLUDED.price_updated_at,reward_public_tokens.price_updated_at),market_cap_usd_pico=COALESCE(EXCLUDED.market_cap_usd_pico,reward_public_tokens.market_cap_usd_pico),reward_status=EXCLUDED.reward_status`,
  [coin.mint,coin.namespace,coin.kind,coin.name,coin.symbol,coin.image_uri,coin.creator_wallet,coin.launch_time,m.decimals,m.supply,price==null?null:String(price),at,cap==null?null:String(cap),obs?(obs.quote_model==='curve'?'pump bonding curve (finalized)':'canonical PumpSwap pool (finalized)'):null,status,coin.kind==='primary',coin.namespace==='mainnet_test']);
}

// ---------------- process ----------------
async function main({role=process.env.REWARDS_WORKER_ROLE||'all',once=process.argv.includes('--once')}={}){
 const worker=`worker:${require('node:os').hostname()}:${process.pid}:${crypto.randomUUID().slice(0,8)}`;
 const rpcUrl=process.env.SOLANA_RPC_URL,historyUrl=process.env.HISTORY_RPC_URL||rpcUrl;if(!rpcUrl)throw Object.assign(Error('SOLANA_RPC_URL is required'),{code:'SETUP_REQUIRED'});
 const connection=new Connection(rpcUrl,'finalized'),rpc=new H.Rpc(historyUrl,{minIntervalMs:Number(process.env.HISTORY_RPC_MIN_INTERVAL_MS||100)});
 const idb=DB.connect(process.env.INDEXER_DATABASE_URL||process.env.DATABASE_URL,{max:3,name:'rebound-indexer'});
 const sdb=DB.connect(process.env.SCHEDULER_DATABASE_URL||process.env.DATABASE_URL,{max:3,name:'rebound-scheduler'});
 const vdb=DB.connect(process.env.VERIFIER_DATABASE_URL||process.env.DATABASE_URL,{max:2,name:'rebound-verifier'});
 let stop=false;for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{stop=true;});
 const program=process.env.REWARDS_PROGRAM_ID?new PublicKey(process.env.REWARDS_PROGRAM_ID):null;if(program)C.bind(program);
 const keyFile=async(env,expected)=>{if(!process.env[env])return null;const k=await require('./config.cjs').keyFromFile(env,expected);return k;};
 const feePayer=program?await keyFile('REWARDS_FEE_PAYER_KEY_FILE',process.env.REWARDS_FEE_PAYER_ADDRESS):null;
 const publisher=program?await keyFile('REWARDS_PUBLISHER_KEY_FILE',process.env.REWARDS_PUBLISHER_ADDRESS):null;
 const verifierKey=program?await keyFile('REWARDS_VERIFIER_KEY_FILE',process.env.REWARDS_VERIFIER_ADDRESS):null;
 const inputs=inputsLoader(idb);
 do{
  const started=Date.now();
  try{
   const coins=(await idb.query("SELECT * FROM reward_coins WHERE program_version='v3' AND status IN ('registered','indexing','ready','active','activating','created_pending_activation','paused')")).rows;
   if(role==='all'||role==='indexer'){
    await sampleSolUsd({db:idb,connection}).catch(e=>Logs.log(idb,{severity:'warn',component:'indexer',eventType:'sol_usd_sample_failed',message:e.message,errorCode:e.code}));
    for(const coin of coins){
     await DB.withLease(idb,'ingest:'+coin.mint,worker,async()=>{
      const r=await ingest({db:idb,rpc},coin);if(r.newTx)await Logs.log(idb,{component:'indexer',eventType:'history_ingested',mint:coin.mint,message:`Ingested ${r.newTx} finalized transaction(s), ${r.newEvents} event(s); coverage ${r.complete?'complete':'INCOMPLETE'} through slot ${r.head}`,metadata:{incomplete:r.incomplete.slice(0,5)}});
      await heartbeat({db:idb,connection},coin).catch(e=>Logs.log(idb,{severity:'warn',component:'indexer',eventType:'heartbeat_failed',mint:coin.mint,message:e.message,errorCode:e.code||'HEARTBEAT_FAILED'}));
      if(coin.kind==='primary')await reconcileFunding({db:idb,rpc},coin);
      else if(program)await R.scanIntake({db:idb,rpc,program},coin);   // creator-fee income vs setup rent/donations
      await projectToken({db:idb,connection},coin);
     },{seconds:300,busy:()=>null}).catch(e=>Logs.log(idb,{severity:'error',component:'indexer',eventType:'ingest_failed',mint:coin.mint,message:e.message,errorCode:e.code||'INDEXER_ERROR'}));
    }
    await Logs.heartbeat(idb,'indexer','ok',{coins:coins.length,ms:Date.now()-started});
   }
   if((role==='all'||role==='scheduler')&&program&&feePayer&&publisher&&verifierKey){
    const ports={db:sdb,connection,program,feePayer,publisher,verifierKey:verifierKey.publicKey,worker,inputs,
     verifier:{cosign:V.cosigner({db:vdb,program,key:verifierKey,inputs:inputsLoader(vdb)}),...R.attestor({rpc:new H.Rpc(process.env.VERIFIER_RPC_URL||historyUrl,{minIntervalMs:100}),connection,program,key:verifierKey})},
     cutoffSlot:async t=>(await H.findCutoffSlot(rpc,t)).slot,now:async()=>connection.getBlockTime(await connection.getSlot('finalized')),
     devSigner:async coin=>{const fw=(await sdb.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired' AND mode='automatic'",[coin.mint])).rows[0];return fw?.signer?Signer.load(sdb,fw.signer):null;},
     primaryAwaiting:(mint,cutoff)=>primaryAwaiting(sdb,mint,cutoff),sponsorRent:process.env.REWARDS_SPONSOR_RENT==='true'};
    await Admin.applyOpeningRequests(sdb,connection).catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'opening_credit_failed',message:e.message}));
    for(const coin of coins.filter(c=>c.status==='active')){
     await C.tick(ports,coin.mint).catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'tick_failed',mint:coin.mint,message:e.message,errorCode:e.code||'SCHEDULER_ERROR'}));
     if(coin.kind!=='third_party')continue;
     // Third-party funding: collect creator fees → verified receipts → Credit (split once) → PRIMARY buyback/burn.
     await DB.withLease(sdb,'third-party:'+coin.mint,worker,async()=>{
      await R.crank(ports,coin);await R.creditStep(ports,coin);
      const last=(await sdb.query('SELECT id FROM reward_cycles WHERE mint=$1 AND cutoff_time<=$2 ORDER BY cycle_number DESC LIMIT 1',[coin.mint,await ports.now()])).rows[0];
      await BB.step(ports,coin,last?.id||null);
     },{seconds:120,busy:()=>null}).catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'third_party_step_failed',mint:coin.mint,message:e.message,errorCode:e.code||'SCHEDULER_ERROR'}));
    }
    await Logs.heartbeat(sdb,'scheduler','ok',{coins:coins.length});
   }else if(role==='all'||role==='scheduler')await Logs.heartbeat(sdb,'scheduler','unconfigured',{reason:'program id or signer files missing; settlement disabled'});
   await Logs.heartbeat(idb,'worker','ok',{role,worker});
  }catch(e){await Logs.heartbeat(idb,'worker','degraded',{error:Logs.redactText(e.message)}).catch(()=>{});}
  if(!once&&!stop)await new Promise(r=>setTimeout(r,Math.max(1000,5000-(Date.now()-started))));
 }while(!once&&!stop);
 await Promise.all([idb.end(),sdb.end(),vdb.end()]);
}
if(require.main===module)main().catch(e=>{process.stderr.write('worker failed: '+(e.code||'')+' '+Logs.redactText(e.message)+'\n');process.exitCode=1;});
module.exports={ingest,inputsLoader,sampleSolUsd,heartbeat,reconcileFunding,primaryAwaiting,projectToken,main};
