'use strict';
// Launch journey (spec §13) through the backend service on the cloned mainnet Pump programs, the compiled
// REBOUND program and PostgreSQL: draft → exact creation tx (browser mint key) → chain-evidenced creation →
// created_pending_activation survives a rejected/closed setup → resumable activation → verified active.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Keypair,Transaction}=require('@solana/web3.js');
const {supabaseDb}=require('./pg.cjs'),L=require('../../server/rewards/launch-v3.cjs'),W3=require('../../server/rewards/wire-v3.cjs'),PV=require('../../server/rewards/pump-v3.cjs');
const {ready,world,SOL}=require('./pump-world.cjs');
const t=ready?test:(name,fn)=>test(name,{skip:'needs contracts/v3/fixtures/mainnet (clone-protocol.cjs) and the SBF build'},fn);
process.env.REWARDS_MAX_EXECUTION_MODE='mainnet_test';

async function setup(){
 const w=await world(),db=await supabaseDb(),wallet=w.user.publicKey.toBase58();
 await db.query("UPDATE reward_platform SET execution_mode='mainnet_test',test_allowlist_wallets=$1,primary_mint=$2 WHERE namespace='mainnet_test'",[[wallet],w.primary.toBase58()]);
 const hash=crypto.createHash('sha256').update('meta').digest('hex');
 await db.query("INSERT INTO reward_assets(hash,kind,bucket,path,mime,bytes,public_url) VALUES($1,'metadata','rebound-token-assets',$2,'application/json',10,'https://rebound.wtf/m/launch-test.json')",[hash,`metadata/${hash}.json`]);
 const session={userId:crypto.randomUUID(),wallets:[wallet]};
 const base={db,connection:w.conn,program:w.program,readMetadata:async()=>({data:{name:'Launch test',symbol:'LNCH'}})};
 // Every launch call runs with the API's own database role (its grants are part of what is tested).
 const asApi=fn=>async(...a)=>{await db.query('SET ROLE rebound_api');try{return await fn(...a);}finally{await db.query('RESET ROLE');}};
 const Lx=Object.fromEntries(['draft','prepare','submit','status','activationPrepare','activationSubmit'].map(k=>[k,asApi(L[k])]));
 return{w,db,ports:base,session,hash,wallet,Lx};
}
const signed=(b64,...signers)=>{const tx=Transaction.from(Buffer.from(b64,'base64'));tx.partialSign(...signers);return tx.serialize().toString('base64');};

t('launch → created_pending_activation after finalized evidence → setup rejected then resumed → verified active',async()=>{
 const {w,db,ports,session,hash,wallet,Lx}=await setup();const L=Lx;try{
  const input={session,wallet,idempotencyKey:'launch-test-0001',metadataHash:hash,name:'Launch test',symbol:'LNCH',initialBuyLamports:300_000_000n,namespace:'mainnet_test'};
  const d=await L.draft(ports,input);assert.equal(d.state,'draft');
  assert.equal((await L.draft(ports,input)).id,d.id,'idempotent draft');
  await assert.rejects(L.draft(ports,{...input,idempotencyKey:'launch-test-0002',name:'Other'}),e=>e.code==='METADATA_MISMATCH');
  const mint=Keypair.generate();   // generated in the browser; the server only sees the public key
  const p=await L.prepare(ports,{session,attemptId:d.id,mint:mint.publicKey.toBase58()});
  assert.equal(p.disclosure.commissionTreasury,W3.addresses(w.program,mint.publicKey).intake.toBase58());assert.equal(p.disclosure.primaryBurnTarget,w.primary.toBase58());
  assert.ok(p.transactions.length>=1);
  // A tampered transaction is refused before broadcast.
  const tx0=Transaction.from(Buffer.from(p.transactions[0],'base64'));const bad=new Transaction({feePayer:w.user.publicKey,recentBlockhash:tx0.recentBlockhash}).add(...tx0.instructions.slice(0,-1));bad.sign(w.user,mint);
  await assert.rejects(L.submit(ports,{session,attemptId:d.id,index:0,signedTransaction:bad.serialize().toString('base64')}),e=>e.code==='FORBIDDEN');
  const s0=await L.submit(ports,{session,attemptId:d.id,index:0,signedTransaction:signed(p.transactions[0],w.user,mint)});assert.equal(s0.state,'submitted');
  let st=await L.status(ports,{session,attemptId:d.id});assert.equal(st.state,'creation_submitted','not recorded before finality');
  w.conn.finalizeAll();st=await L.status(ports,{session,attemptId:d.id});assert.equal(st.state,'created_pending_activation');
  const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint.publicKey.toBase58()])).rows[0];assert.equal(coin.status,'created_pending_activation');assert.equal(coin.intake,st.intake);
  if(p.transactions[1]){const s1=await L.submit(ports,{session,attemptId:d.id,index:1,signedTransaction:signed(p.transactions[1],w.user)});assert.equal(s1.state,'submitted');}
  // The user closes the browser / rejects the setup signature: the token exists, rewards stay inactive.
  let a=await L.activationPrepare(ports,{session,attemptId:d.id});assert.deepEqual(a.steps.map(s=>s.name),['create_fee_sharing','lock_fee_sharing']);
  w.conn.finalizeAll();st=await L.status(ports,{session,attemptId:d.id});assert.equal(st.state,'activating');
  assert.equal((await db.query("SELECT count(*)::int n FROM reward_public_tokens WHERE mint=$1",[st.mint])).rows[0].n,0,'not published before verification');
  // Resume: sign the first step only, then resume again → only the remaining step is offered.
  await L.activationSubmit(ports,{session,attemptId:d.id,step:'create_fee_sharing',signedTransaction:signed(a.steps[0].transaction,w.user)});w.conn.finalizeAll();
  a=await L.activationPrepare(ports,{session,attemptId:d.id});assert.deepEqual(a.steps.map(s=>s.name),['lock_fee_sharing']);
  await L.activationSubmit(ports,{session,attemptId:d.id,step:'lock_fee_sharing',signedTransaction:signed(a.steps[0].transaction,w.user)});w.conn.finalizeAll();
  st=await L.status(ports,{session,attemptId:d.id});assert.equal(st.state,'active');
  assert.equal((await db.query('SELECT status FROM reward_coins WHERE mint=$1',[st.mint])).rows[0].status,'active');
  const pub=(await db.query('SELECT * FROM reward_public_tokens WHERE mint=$1',[st.mint])).rows[0];assert.equal(pub.reward_status,'active');assert.equal(pub.test,true);
  const v=await PV.verifyRouting(w.conn,w.program,st.mint);assert.equal(v.intake,st.intake);
 }finally{await db.close();}
});

t('a creation that never lands is proven expired before a new one is prepared; no duplicate token',async()=>{
 const {w,db,ports,session,hash,wallet,Lx}=await setup();const L=Lx;try{
  const d=await L.draft(ports,{session,wallet,idempotencyKey:'launch-test-0003',metadataHash:hash,name:'Launch test',symbol:'LNCH',initialBuyLamports:0n,namespace:'mainnet_test'});
  const m1=Keypair.generate();const p1=await L.prepare(ports,{session,attemptId:d.id,mint:m1.publicKey.toBase58()});
  w.conn.faults.rejectSend=2;   // wallet signed, but the network never accepted it (and the rebroadcast fails)
  const s=await L.submit(ports,{session,attemptId:d.id,index:0,signedTransaction:signed(p1.transactions[0],w.user,m1)});assert.equal(s.state,'uncertain');
  await assert.rejects(L.prepare(ports,{session,attemptId:d.id,mint:Keypair.generate().publicKey.toBase58()}),e=>e.code==='LAUNCH_STATE');
  let st=await L.status(ports,{session,attemptId:d.id});assert.equal(st.state,'creation_submitted','still possibly landing');
  w.conn.advance({blocks:400});st=await L.status(ports,{session,attemptId:d.id});assert.equal(st.state,'draft','proven expired: nothing exists on chain');
  assert.equal(await w.conn.getAccountInfo(m1.publicKey),null);
  const m2=Keypair.generate();const p2=await L.prepare(ports,{session,attemptId:d.id,mint:m2.publicKey.toBase58()});
  await L.submit(ports,{session,attemptId:d.id,index:0,signedTransaction:signed(p2.transactions[0],w.user,m2)});w.conn.finalizeAll();
  st=await L.status(ports,{session,attemptId:d.id});assert.equal(st.state,'created_pending_activation');assert.equal(st.mint,m2.publicKey.toBase58());
  assert.equal((await db.query("SELECT count(*)::int n FROM reward_coins WHERE kind='third_party'")).rows[0].n,1);
 }finally{await db.close();}
});

test('launches follow the namespace execution mode: dry run and non-allowlisted wallets are refused',async()=>{
 const db=await supabaseDb();try{
  await assert.rejects(L.launchAllowed(db,'mainnet_test','W'),e=>e.code==='DRY_RUN');
  await db.query("UPDATE reward_platform SET execution_mode='mainnet_test',test_allowlist_wallets='{A}' WHERE namespace='mainnet_test'");
  const prev=process.env.REWARDS_MAX_EXECUTION_MODE;process.env.REWARDS_MAX_EXECUTION_MODE='mainnet_test';
  try{await assert.rejects(L.launchAllowed(db,'mainnet_test','B'),e=>e.code==='TEST_WALLET_NOT_ALLOWED');assert.equal(await L.launchAllowed(db,'mainnet_test','A'),'mainnet_test');
   await assert.rejects(L.launchAllowed(db,'production','A'),e=>e.code==='DRY_RUN'||e.code==='NAMESPACE');}
  finally{process.env.REWARDS_MAX_EXECUTION_MODE=prev;}
 }finally{await db.close();}
});
