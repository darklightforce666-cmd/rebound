'use strict';
// Worker ingestion and evidence loading against a real PostgreSQL engine and a fake finalized RPC.
const test=require('node:test'),assert=require('node:assert/strict');
const {Keypair}=require('@solana/web3.js');
const {supabaseDb}=require('./pg.cjs'),Wk=require('../../server/rewards/worker-v3.cjs'),H=require('../../server/rewards/history-v3.cjs'),FS=require('../../server/rewards/funding-store.cjs');
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',SYS='11111111111111111111111111111111',SOL=1000000000n;
const key=()=>Keypair.generate().publicKey.toBase58();

// A finalized chain: blocks hold ordered signatures; each address has a newest-first signature list.
function fakeChain(){
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
   if(m==='getTransaction')return down.has(p[0])?null:txs.get(p[0])||null;
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
 await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES($1,'h','active','primary','mainnet_test','v3','rebound-v3.0')",[mint]);
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

test('an unavailable transaction marks coverage incomplete and never advances the cursor past it',async()=>{
 const {db,mint,coin}=await setup();try{
  const chain=fakeChain(),A=key(),B=key(),ta=key(),tb=key();
  const s1=chain.add(transfer({mint,from:A,fromAcc:ta,to:B,toAcc:tb,amount:5,pre:[100,0],slot:20}),[mint,ta,tb]);
  chain.down.add(s1);
  let r=await Wk.ingest({db,rpc:chain},coin);assert.equal(r.complete,false);
  let cp=(await db.query('SELECT * FROM reward_checkpoints WHERE name=$1',['history:'+mint])).rows[0];assert.equal(cp.complete,false);assert.match(JSON.stringify(cp.incident),/transaction_unavailable/);
  assert.equal((await db.query("SELECT newest_signature FROM reward_history_cursors WHERE mint=$1 AND role='mint'",[mint])).rows[0].newest_signature,null);
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

test('dev-wallet reconciliation treats REBOUND holder deposits (manual intent or automatic attempt) as liability moves, not new funding',async()=>{
 const db=await supabaseDb();try{
  const DEV=key(),mint=key(),crypto=require('node:crypto');
  await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES($1,'h','active','primary','mainnet_test','v3','rebound-v3.0')",[mint]);
  await db.query("INSERT INTO reward_funding_wallets(id,namespace,mint,address,ownership_proof) VALUES($1,'mainnet_test',$2,$3,'{}')",[crypto.randomUUID(),mint,DEV]);
  await FS.recordOpening(db,{mint,wallet:DEV,balance:2n*SOL,requestedCredit:SOL,operationalReserve:0n,slot:100,time:100});
  const chain=fakeChain();let slot=100;
  const sysTx=(sig,payer,pre,post,from,to,lamports)=>{slot++;const keys=[payer,DEV,from,to].filter((k,i,a)=>a.indexOf(k)===i);
   return{slot,blockTime:slot,transaction:{signatures:[sig],message:{accountKeys:keys,instructions:[{programId:SYS,parsed:{type:'transfer',info:{source:from,destination:to,lamports:Number(lamports)}}}]}},meta:{err:null,fee:5000,preBalances:keys.map(k=>k===DEV?Number(pre):0),postBalances:keys.map(k=>k===DEV?Number(post):0),innerInstructions:[]}};};
  const T=key(),X=key(),Fee=key();
  chain.add(sysTx('fee-in',X,2n*SOL,3n*SOL,X,DEV,SOL),[DEV]);                                     // new creator fees: 1 SOL
  chain.add(sysTx('auto-dep',Fee,3n*SOL,3n*SOL-850000000n,DEV,T,850000000n),[DEV]);              // automatic deposit (attempt context)
  await db.query("INSERT INTO reward_chain_attempts(id,job,state,signature,transaction_bytes,last_valid_block_height,context,kind,mint) VALUES($1,'deposit:c1','finalized','auto-dep','',1,$2,'primary_funding',$3)",[crypto.randomUUID(),JSON.stringify({cycle:1,amount:'850000000'}),mint]);
  const out=await Wk.reconcileFunding({db,rpc:chain},{mint});assert.deepEqual(out,{credits:1,incidents:0});
  const a=(await db.query('SELECT * FROM reward_funding_accounts WHERE mint=$1',[mint])).rows[0];
  assert.equal(a.credited,'2000000000','opening 1 SOL + 1 SOL of new fees; the deposit is not funding');
  assert.equal(a.holder_awaiting_transfer,'850000000');
  assert.equal((await Wk.reconcileFunding({db,rpc:chain},{mint})).credits,0,'reconciliation resumes after the last signature');
  assert.equal(await Wk.primaryAwaiting(db,mint,10_000),850000000n);
  assert.equal(await Wk.primaryAwaiting(db,mint,100),0n,'funding credited after the cutoff is not usable for that cycle');
 }finally{await db.close();}
});
