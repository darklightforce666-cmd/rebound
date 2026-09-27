'use strict';
// Worker ingestion and evidence loading against a real PostgreSQL engine and a fake finalized RPC.
const test=require('node:test'),assert=require('node:assert/strict');
const {Keypair}=require('@solana/web3.js');
const {supabaseDb}=require('./pg.cjs'),Wk=require('../../server/rewards/worker-v3.cjs'),H=require('../../server/rewards/history-v3.cjs'),FS=require('../../server/rewards/funding-store.cjs');
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',SYS='11111111111111111111111111111111',SOL=1000000000n;
const key=()=>Keypair.generate().publicKey.toBase58();

// A finalized chain: blocks hold ordered signatures; each address has a newest-first signature list.
function fakeChain({reportIndex=false}={}){
 const txs=new Map(),blocks=new Map(),byAddress=new Map(),calls={};let head=0;const down=new Set();
 const api={calls,down,
  add(tx,addresses){const sig=tx.transaction.signatures[0];txs.set(sig,tx);head=Math.max(head,tx.slot);
   if(!blocks.has(tx.slot))blocks.set(tx.slot,['other-'+tx.slot]);blocks.get(tx.slot).push(sig);
   for(const a of addresses){if(!byAddress.has(a))byAddress.set(a,[]);byAddress.get(a).unshift({signature:sig,slot:tx.slot,err:null});}return sig;},
  async call(m,p){calls[m]=(calls[m]||0)+1;
   if(m==='getSlot')return head;
   if(m==='getBlockTime')return 1000+p[0];
   if(m==='getSignaturesForAddress'){const list=byAddress.get(p[0])||[],o=p[1];let out=list;
    if(o.until){const i=out.findIndex(s=>s.signature===o.until);if(i>=0)out=out.slice(0,i);}
    if(o.before){const i=out.findIndex(s=>s.signature===o.before);out=out.slice(i+1);}return out.slice(0,o.limit);}
   if(m==='getTransaction'){if(p[1].maxSupportedTransactionVersion!==1)return null;const t=down.has(p[0])?null:txs.get(p[0])||null;return t&&reportIndex?{...t,transactionIndex:blocks.get(t.slot).indexOf(p[0])}:t;}
   if(m==='getBlock')return{signatures:blocks.get(p[0])||[]};
   throw Error('unexpected '+m);}};
 return api;
}
let sigN=0;
function transfer({mint,from,fromAcc,to,toAcc,amount,pre,slot}){
 const sig='tx'+(++sigN);
 return{slot,blockTime:1000+slot,transaction:{signatures:[sig],message:{accountKeys:[from,fromAcc,mint,toAcc,TOKEN].map(p=>({pubkey:p})),
  instructions:[{programId:TOKEN,parsed:{type:'transferChecked',info:{source:fromAcc,mint,destination:toAcc,tokenAmount:{amount:String(amount),decimals:6},authority:from}},stackHeight:1}]}},
  meta:{err:null,fee:5000,innerInstructions:[],preBalances:[1,1,1,1,1],postBalances:[1,1,1,1,1],
   preTokenBalances:[{accountIndex:1,mint,owner:from,uiTokenAmount:{amount:String(pre[0])}},{accountIndex:3,mint,owner:to,uiTokenAmount:{amount:String(pre[1])}}],
   postTokenBalances:[{accountIndex:1,mint,owner:from,uiTokenAmount:{amount:String(pre[0]-amount)}},{accountIndex:3,mint,owner:to,uiTokenAmount:{amount:String(pre[1]+amount)}}]}};
}
async function setup(){
 const db=await supabaseDb(),mint=key();
 await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES($1,'h','active','primary','mainnet_test','v3','rebound-v3.1')",[mint]);
 return{db,mint,coin:(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0]};
}

test('ingest discovers token accounts, records exact in-block order, and resumes incrementally from cursors',async()=>{
 const {db,mint,coin}=await setup();try{
  const chain=fakeChain(),A=key(),B=key(),C=key(),ta=key(),tb=key(),tc=key();
  const t1=transfer({mint,from:A,fromAcc:ta,to:B,toAcc:tb,amount:40,pre:[100,0],slot:10});chain.add(t1,[mint,ta,tb]);   // transferChecked touches the mint
  let r=await Wk.ingest({db,rpc:chain},coin);
  assert.equal(r.complete,true);assert.equal(r.newTx,1);
  const cursors=(await db.query('SELECT address,role,newest_signature FROM reward_history_cursors WHERE mint=$1 ORDER BY role,address',[mint])).rows;
  assert.deepEqual(cursors.filter(c=>c.role==='token_account').map(c=>c.address).sort(),[ta,tb].sort());
  const ev=(await db.query('SELECT kind,transaction_index,slot FROM reward_events WHERE mint=$1 ORDER BY execution_order,event_index',[mint])).rows;
  assert.deepEqual(ev.map(e=>e.kind),['transfer_exit','incoming_transfer','token_balances']);
  assert.ok(ev.every(e=>e.transaction_index===1&&Number(e.slot)===10),'index is the position inside the finalized block');
  // A later transfer that touches only token accounts (no mint key) is still found through the token-account cursors.
  const t2=transfer({mint,from:B,fromAcc:tb,to:C,toAcc:tc,amount:10,pre:[40,0],slot:12});t2.transaction.message.accountKeys.splice(2,1,{pubkey:key()});
  t2.transaction.message.instructions[0].parsed={type:'transfer',info:{source:tb,destination:tc,amount:'10',authority:B}};chain.add(t2,[tb,tc]);
  const before=chain.calls.getTransaction;r=await Wk.ingest({db,rpc:chain},coin);
  assert.equal(r.newTx,1);assert.equal(chain.calls.getTransaction-before,1,'already-ingested history is never refetched');
  assert.ok((await db.query("SELECT 1 FROM reward_history_cursors WHERE mint=$1 AND address=$2 AND role='token_account'",[mint,tc])).rows.length,'recipient account discovered');
  const cp=(await db.query('SELECT * FROM reward_checkpoints WHERE name=$1',['history:'+mint])).rows[0];assert.equal(cp.complete,true);assert.equal(Number(cp.through_slot),12);
  r=await Wk.ingest({db,rpc:chain},coin);assert.equal(r.newTx,0);
 }finally{await db.close();}
});

test('an unavailable transaction marks coverage incomplete and stays queued until it is fetched',async()=>{
 const {db,mint,coin}=await setup();try{
  const chain=fakeChain(),A=key(),B=key(),ta=key(),tb=key();
  const s1=chain.add(transfer({mint,from:A,fromAcc:ta,to:B,toAcc:tb,amount:5,pre:[100,0],slot:20}),[mint,ta,tb]);
  chain.down.add(s1);
  let r=await Wk.ingest({db,rpc:chain},coin);assert.equal(r.complete,false);
  let cp=(await db.query('SELECT * FROM reward_checkpoints WHERE name=$1',['history:'+mint])).rows[0];assert.equal(cp.complete,false);assert.match(JSON.stringify(cp.incident),/transaction_unavailable/);
  assert.equal((await db.query('SELECT fetched_at FROM reward_history_queue WHERE mint=$1 AND signature=$2',[mint,s1])).rows[0].fetched_at,null,'listed but not fetched: kept in the queue');
  const inputs=await Wk.inputsLoader(db)(coin,1,1000+30,30);assert.equal(inputs.coverage.complete,false,'snapshot sees incomplete coverage and holds');
  chain.down.clear();r=await Wk.ingest({db,rpc:chain},coin);assert.equal(r.complete,true);assert.equal(r.newTx,1);
  cp=(await db.query('SELECT * FROM reward_checkpoints WHERE name=$1',['history:'+mint])).rows[0];assert.equal(cp.complete,true);
 }finally{await db.close();}
});

test('inputsLoader returns only finalized evidence at or before the cutoff slot, in execution order, with market exclusions',async()=>{
 const {db,mint,coin}=await setup();try{
  const chain=fakeChain(),A=key(),B=key(),ta=key(),tb=key();
  chain.add(transfer({mint,from:A,fromAcc:ta,to:B,toAcc:tb,amount:5,pre:[100,0],slot:30}),[mint,ta,tb]);
  chain.add(transfer({mint,from:A,fromAcc:ta,to:B,toAcc:tb,amount:5,pre:[95,5],slot:40}),[mint,ta,tb]);
  await Wk.ingest({db,rpc:chain},coin);
  const inputs=await Wk.inputsLoader(db)(coin,1,1000+35,35);
  assert.ok(inputs.events.length>0&&inputs.events.every(e=>e.slot<=35));
  assert.deepEqual(inputs.coverage,{complete:true,throughSlot:40});
  assert.ok(inputs.excluded.has(H.marketAddresses(mint).curve)&&inputs.excluded.has(H.marketAddresses(mint).pool));
  assert.deepEqual(inputs.credits,[]);assert.equal(typeof inputs.fx,'function');
 }finally{await db.close();}
});

test('dev-wallet reconciliation (scheduler role): holder deposits are recognized from the program instruction, never from database labels; gaps stop it',async()=>{
 const db=await supabaseDb();try{
  const DEV=key(),mint=key(),crypto=require('node:crypto'),bs58=require('bs58'),W3=require('../../server/rewards/wire-v3.cjs'),{PublicKey}=require('@solana/web3.js');
  const program=Keypair.generate().publicKey,coinPda=W3.addresses(program,new PublicKey(mint)).coin.toBase58();
  await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES($1,'h','active','primary','mainnet_test','v3','rebound-v3.1')",[mint]);
  await db.query("INSERT INTO reward_funding_wallets(id,namespace,mint,address,ownership_proof) VALUES($1,'mainnet_test',$2,$3,'{}')",[crypto.randomUUID(),mint,DEV]);
  await FS.recordOpening(db,{mint,wallet:DEV,balance:2n*SOL,requestedCredit:SOL,operationalReserve:0n,slot:100,time:100});
  const chain=fakeChain();let slot=100;
  const sysTx=(sig,payer,pre,post,from,to,lamports,extra=[])=>{slot++;const keys=[payer,DEV,from,to].filter((k,i,a)=>a.indexOf(k)===i);
   return{slot,blockTime:slot,transaction:{signatures:[sig],message:{accountKeys:keys,instructions:[...extra,{programId:SYS,parsed:{type:'transfer',info:{source:from,destination:to,lamports:Number(lamports)}}}]}},meta:{err:null,fee:5000,preBalances:keys.map(k=>k===DEV?Number(pre):0),postBalances:keys.map(k=>k===DEV?Number(post):0),innerInstructions:[]}};};
  const depositIx=amount=>{const d=Buffer.alloc(9);d[0]=W3.TAG.DepositHolders;d.writeBigUInt64LE(amount,1);return{programId:program.toBase58(),accounts:[DEV,W3.addresses(program).deployment.toBase58(),coinPda,SYS],data:bs58.encode(d)};};
  const X=key(),Fee=key();
  chain.add(sysTx('fee-in',X,2n*SOL,3n*SOL,X,DEV,SOL),[DEV]);                                                    // new creator fees: 1 SOL
  chain.add(sysTx('dep',Fee,3n*SOL,3n*SOL-850000000n,DEV,coinPda,850000000n,[depositIx(850000000n)]),[DEV]);   // DepositHolders
  // A forged database label (the API role can write chain attempts) must not turn the fee inflow into a "deposit".
  await db.query("INSERT INTO reward_chain_attempts(id,job,state,signature,transaction_bytes,last_valid_block_height,context,kind,mint) VALUES($1,'forged','finalized','fee-in','',1,$2,'primary_funding',$3)",[crypto.randomUUID(),JSON.stringify({amount:'1000000000'}),mint]);
  const asScheduler=async fn=>{await db.query('SET ROLE rebound_scheduler');try{return await fn();}finally{await db.query('RESET ROLE');}};
  const out=await asScheduler(()=>Wk.reconcileFunding({db,rpc:chain,program},{mint}));assert.deepEqual(out,{credits:1,incidents:0});
  const a=(await db.query('SELECT * FROM reward_funding_accounts WHERE mint=$1',[mint])).rows[0];
  assert.equal(a.credited,'2000000000','opening 1 SOL + 1 SOL of new fees; the deposit is not funding');
  assert.equal(a.holder_awaiting_transfer,'850000000');
  assert.equal((await asScheduler(()=>Wk.reconcileFunding({db,rpc:chain,program},{mint}))).credits,0,'reconciliation resumes after the last signature');
  assert.equal(await Wk.primaryAwaiting(db,mint,10_000),850000000n);
  assert.equal(await Wk.primaryAwaiting(db,mint,100),0n,'funding credited after the cutoff is not usable for that cycle');
  // An unreadable transaction stops reconciliation there; later ones wait until it can be read.
  chain.add(sysTx('fee-2',X,3n*SOL-850000000n,4n*SOL-850000000n,X,DEV,SOL),[DEV]);chain.add(sysTx('fee-3',X,4n*SOL-850000000n,5n*SOL-850000000n,X,DEV,SOL),[DEV]);
  chain.down.add('fee-2');
  assert.deepEqual(await asScheduler(()=>Wk.reconcileFunding({db,rpc:chain,program},{mint})),{credits:0,incidents:0,gap:'fee-2'});
  assert.equal((await db.query('SELECT credited FROM reward_funding_accounts WHERE mint=$1',[mint])).rows[0].credited,'2000000000');
  chain.down.delete('fee-2');
  assert.equal((await asScheduler(()=>Wk.reconcileFunding({db,rpc:chain,program},{mint}))).credits,2);
  assert.equal((await db.query('SELECT credited FROM reward_funding_accounts WHERE mint=$1',[mint])).rows[0].credited,'4000000000');
  // The indexer login cannot write funding ledgers at all.
  await db.query('SET ROLE rebound_indexer');try{await assert.rejects(db.query('UPDATE reward_funding_accounts SET credited=0 WHERE mint=$1',[mint]),/permission denied/);}finally{await db.query('RESET ROLE');}
 }finally{await db.close();}
});

test('v1 transactions are requested and the RPC-reported block index is used without refetching blocks',async()=>{
 const {db,mint,coin}=await setup();try{
  const chain=fakeChain({reportIndex:true}),A=key(),B=key(),ta=key(),tb=key();
  chain.add(transfer({mint,from:A,fromAcc:ta,to:B,toAcc:tb,amount:5,pre:[100,0],slot:50}),[mint,ta,tb]);
  const r=await Wk.ingest({db,rpc:chain},coin);assert.equal(r.complete,true);assert.equal(r.newTx,1);
  assert.equal(chain.calls.getBlock||0,0);
  assert.ok((await db.query('SELECT transaction_index FROM reward_events WHERE mint=$1',[mint])).rows.every(e=>e.transaction_index===1));
 }finally{await db.close();}
});

test('signing preflight: network, deployment keys and policy must match before the scheduler signs',async()=>{
 const {PublicKey}=require('@solana/web3.js'),W3=require('../../server/rewards/wire-v3.cjs'),P3=require('../../server/rewards/policy-v3.cjs');
 const program=Keypair.generate().publicKey,publisher=Keypair.generate().publicKey,verifier=Keypair.generate().publicKey,other=Keypair.generate().publicKey;
 const deployment=(testMode,policyHex)=>Buffer.concat([Buffer.from('RBD3DEP0'),other.toBuffer(),publisher.toBuffer(),verifier.toBuffer(),other.toBuffer(),Buffer.from(policyHex,'hex'),Buffer.from([testMode?1:0,0]),Buffer.alloc(8),new PublicKey(SYS).toBuffer(),new PublicKey(SYS).toBuffer(),Buffer.alloc(8)]);
 const conn=(genesis,data,owner=program)=>({getGenesisHash:async()=>genesis,getAccountInfo:async a=>{assert.ok(a.equals(W3.addresses(program).deployment));return data?{owner,data}:null;}});
 const G='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',ok=deployment(true,P3.hashOf(P3.TEST_POLICY));
 assert.deepEqual(await Wk.preflightV3({connection:conn(G,ok),program,publisher,verifier,genesis:G}),{ok:true,testMode:true,paused:false});
 assert.match((await Wk.preflightV3({connection:conn('devnet',ok),program,publisher,verifier,genesis:G})).reason,/wrong network/);
 assert.match((await Wk.preflightV3({connection:conn(G,null),program,publisher,verifier,genesis:G})).reason,/not initialized/);
 assert.match((await Wk.preflightV3({connection:conn(G,ok,other),program,publisher,verifier,genesis:G})).reason,/not initialized/);
 assert.match((await Wk.preflightV3({connection:conn(G,ok),program,publisher:other,verifier,genesis:G})).reason,/publisher/);
 assert.match((await Wk.preflightV3({connection:conn(G,ok),program,publisher,verifier:other,genesis:G})).reason,/verifier/);
 assert.match((await Wk.preflightV3({connection:conn(G,deployment(false,P3.hashOf(P3.TEST_POLICY))),program,publisher,verifier,genesis:G})).reason,/production policy/);
 assert.equal((await Wk.preflightV3({connection:conn(G,deployment(false,P3.POLICY_HASH)),program,publisher,verifier,genesis:G})).ok,true);
});

test('SOL/USD: Hermes sample preferred when keyed; purchases without a valid sample are backfilled once',async()=>{
 const FX=require('../../server/rewards/sol-usd.cjs'),P3=require('../../server/rewards/policy-v3.cjs');
 const db=await supabaseDb();try{
  const mint=key(),obs=t=>({time:t,price:150n*10n**12n,conf:10n**10n,source:'pyth-benchmarks',evidence:{t}});
  await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES($1,$2,'active','primary','mainnet_test','v3','rebound-v3.0-test')",[mint,P3.hashOf(P3.TEST_POLICY)]);
  const ev=(id,t,kind='purchase_candidate')=>db.query("INSERT INTO reward_events(id,mint,signature,instruction_path,event_index,slot,transaction_index,execution_order,kind,owner,data,raw_digest,parser_version,finalized) VALUES($1,$2,$1,'0',0,$3,0,0,$4,$5,$6,'d','v',true)",[id,mint,t,kind,key(),{time:t}]);
  await ev('a',1_800_000_000);await ev('b',1_800_000_100);await ev('c',1_800_000_200,'transfer');
  await FX.persist(db,obs(1_800_000_090));                                                      // b already covered (10 s old)
  const asked=[];const at=async(t,{window})=>{asked.push([t,window]);return[obs(t-3),obs(t-1)];};
  assert.equal(await Wk.backfillSolUsd({db,at,configured:false},mint),0,'nothing without a key');
  assert.equal(await Wk.backfillSolUsd({db,at,configured:true},mint),1);assert.deepEqual(asked,[[1_800_000_000,30]]);
  assert.equal(await Wk.backfillSolUsd({db,at,configured:true},mint),0,'idempotent');
  const s=await FX.load(db,1_799_999_990,1_800_000_000);assert.deepEqual(s.map(x=>x.time),[1_799_999_999]);
  const live=await Wk.sampleSolUsd({db,connection:{getAccountInfoAndContext:async()=>{throw Error('on-chain must not be read');}},hermes:async()=>obs(1_800_000_500)});
  assert.equal(live.time,1_800_000_500);
  const fallback=await Wk.sampleSolUsd({db,connection:{getAccountInfoAndContext:async()=>({context:{slot:1},value:null})},hermes:async()=>{throw Object.assign(Error('down'),{code:'SOL_USD_SOURCE_UNAVAILABLE'});}});
  assert.equal(fallback,null);assert.ok((await db.query("SELECT 1 FROM reward_logs WHERE event_type='sol_usd_hermes_failed'")).rows.length);
 }finally{await db.close();}
});

test('with current holders known, only their token accounts are crawled and each transaction is fetched once, in batches',async()=>{
 const {db,mint,coin}=await setup();try{
  const chain=fakeChain({reportIndex:true}),A=key(),B=key(),C=key(),ta=key(),tb=key(),tc=key();
  chain.add(transfer({mint,from:A,fromAcc:ta,to:B,toAcc:tb,amount:40,pre:[100,0],slot:10}),[mint,ta,tb]);
  chain.add(transfer({mint,from:A,fromAcc:ta,to:C,toAcc:tc,amount:60,pre:[60,0],slot:11}),[ta,tc]);   // A sold out
  const orig=chain.call.bind(chain);let batches=0;
  chain.call=async(m,p)=>{if(m==='getAccountInfo')return{value:{owner:TOKEN}};
   if(m==='getProgramAccounts'){chain.calls[m]=(chain.calls[m]||0)+1;return[tb,tc].map(a=>({pubkey:a,account:{data:{parsed:{info:{owner:a===tb?B:C,tokenAmount:{amount:'10'}}}}}}));}
   return orig(m,p);};
  chain.batch=async calls=>{batches++;return Promise.all(calls.map(([m,p])=>chain.call(m,p)));};
  const r=await Wk.ingest({db,rpc:chain},coin);
  assert.equal(r.complete,true);assert.equal(r.newTx,2);assert.equal(r.holders,2);assert.ok(batches>=1);
  assert.equal(chain.calls.getTransaction,2,'each transaction exactly once, although listed under several addresses');
  const listed=(await db.query('SELECT count(*)::int n FROM reward_history_queue WHERE mint=$1',[mint])).rows[0].n;assert.equal(listed,2);
  const crawled=chain.calls.getSignaturesForAddress;
  assert.equal(crawled,5,'mint, curve, pool and the two current holders; the sold-out wallet is never listed');
  const again=await Wk.ingest({db,rpc:chain},coin);assert.equal(again.newTx,0);assert.equal(chain.calls.getTransaction,2);
 }finally{await db.close();}
});
