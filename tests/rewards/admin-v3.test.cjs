'use strict';
// Administrator operations run with the API's own database role.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Keypair}=require('@solana/web3.js');
const {supabaseDb}=require('./pg.cjs'),A=require('../../server/rewards/admin-v3.cjs'),P3=require('../../server/rewards/policy-v3.cjs');
const key=()=>Keypair.generate().publicKey.toBase58();

async function setup(){
 const db=await supabaseDb();const asApi=fn=>async(...a)=>{await db.query('SET ROLE rebound_api');try{return await fn(...a);}finally{await db.query('RESET ROLE');}};
 return{db,api:Object.fromEntries(Object.entries(A).filter(([,f])=>typeof f==='function').map(([k,f])=>[k,asApi(f)]))};
}

test('execution mode: production stays locked for a private test; namespace/mode pairs enforced; audited',async()=>{
 const {db,api}=await setup();const admin=key();try{
  await assert.rejects(api.setMode(db,admin,{namespace:'production',mode:'production'}),e=>e.code==='PRODUCTION_LOCKED');
  await assert.rejects(api.setMode(db,admin,{namespace:'production',mode:'mainnet_test'}),e=>e.code==='NAMESPACE');
  const r=await api.setMode(db,admin,{namespace:'mainnet_test',mode:'mainnet_test',reason:'private test'});assert.equal(r.mode,'mainnet_test');
  assert.equal((await db.query("SELECT execution_mode FROM reward_platform WHERE namespace='mainnet_test'")).rows[0].execution_mode,'mainnet_test');
  assert.ok((await db.query("SELECT 1 FROM reward_audit WHERE kind='admin_set_mode'")).rows.length);
 }finally{await db.close();}
});

test('test configuration validates addresses and caps; pause/resume',async()=>{
 const {db,api}=await setup();const admin=key(),m=key(),w=key();try{
  await assert.rejects(api.testConfig(db,admin,{mints:['nope'],wallets:[],capAction:'1',capCycle:'1',capTotal:'1',slippageBps:100,impactBps:200}),e=>e.code==='INVALID_BODY');
  await assert.rejects(api.testConfig(db,admin,{mints:[m],wallets:[w],capAction:'10',capCycle:'5',capTotal:'100',slippageBps:100,impactBps:200}),e=>e.code==='INVALID_BODY');
  await api.testConfig(db,admin,{mints:[m,m],wallets:[w],capAction:'100000000',capCycle:'200000000',capTotal:'500000000',slippageBps:150,impactBps:300});
  const p=(await db.query("SELECT * FROM reward_platform WHERE namespace='mainnet_test'")).rows[0];
  assert.deepEqual(p.test_allowlist_mints,[m]);assert.equal(p.spend_cap_total_lamports,'500000000');assert.equal(p.buyback_max_impact_bps,300);
  await api.pause(db,admin,{namespace:'mainnet_test',paused:true,reason:'maintenance'});assert.equal((await db.query("SELECT paused FROM reward_platform WHERE namespace='mainnet_test'")).rows[0].paused,true);
  await api.pause(db,admin,{namespace:'mainnet_test',paused:false});
 }finally{await db.close();}
});

test('primary registration requires the dev wallet to be proven by the session; policy follows the namespace',async()=>{
 const {db,api}=await setup();const admin=key(),dev=key(),mint=key();try{
  await assert.rejects(api.registerPrimary(db,admin,{userId:crypto.randomUUID(),reboundWallets:[admin]},{namespace:'mainnet_test',mint,fundingWallet:dev}),e=>e.code==='FORBIDDEN');
  const r=await api.registerPrimary(db,admin,{userId:crypto.randomUUID(),reboundWallets:[admin,dev]},{namespace:'mainnet_test',mint,fundingWallet:dev});
  const plat=(await db.query("SELECT * FROM reward_platform WHERE namespace='mainnet_test'")).rows[0];
  assert.equal(plat.primary_mint,mint);assert.equal(r.policyHash,P3.hashOf(P3.policy(plat.policy_version)));
  const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0];assert.equal(coin.kind,'primary');assert.equal(coin.status,'registered');
  assert.equal((await db.query("SELECT mode FROM reward_funding_wallets WHERE mint=$1",[mint])).rows[0].mode,'manual');
  const o=await api.overview(db);assert.ok(o.coins.some(c=>c.mint===mint));assert.equal(o.productionAllowed,false);
  assert.ok(o.signers.every(s=>!('ciphertext' in s)),'no signer secrets');
  await assert.rejects(api.revokeAdmin(db,admin,{wallet:admin}),e=>e.code==='FORBIDDEN');
 }finally{await db.close();}
});

test('program governance actions: exact unsigned transaction for the admin wallet, simulated first, verified before broadcast',async(t)=>{
 const fs=require('node:fs'),path=require('node:path');if(!fs.existsSync(path.join(__dirname,'../../contracts/v3/target/deploy/rebound_rewards_v3.so')))return t.skip('SBF build missing');
 const {SvmConnection}=require('./svm-connection.cjs'),{Transaction}=require('@solana/web3.js'),W3=require('../../server/rewards/wire-v3.cjs');
 const {db,api}=await setup();try{
  const admin=Keypair.generate(),program=Keypair.generate().publicKey,conn=new SvmConnection({program,admin:admin.publicKey});conn.airdrop(admin.publicKey,10n**10n);
  const [p,v,g]=[key(),key(),key()],ports={connection:conn,program};
  await assert.rejects(api.chainPrepare(db,ports,{admin:key(),action:'initialize',params:{publisher:p,verifier:v,guardian:g,testMode:true}}),e=>e.code==='SIMULATION_FAILED');   // not the upgrade authority
  const other=await api.chainPrepare(db,ports,{admin:admin.publicKey.toBase58(),action:'initialize',params:{publisher:p,verifier:v,guardian:g,testMode:false}});
  const prep=await api.chainPrepare(db,ports,{admin:admin.publicKey.toBase58(),action:'initialize',params:{publisher:p,verifier:v,guardian:g,testMode:true}});
  const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(admin);
  await assert.rejects(api.chainSubmit(db,ports,admin.publicKey.toBase58(),{intentId:other.intentId,signedTransaction:tx.serialize().toString('base64')}),e=>e.code==='FORBIDDEN');   // signed bytes of a different prepared action
  const r=await api.chainSubmit(db,ports,admin.publicKey.toBase58(),{intentId:prep.intentId,signedTransaction:tx.serialize().toString('base64')});assert.equal(r.state,'submitted');
  const d=W3.decode('deployment',(await conn.getAccountInfo(W3.addresses(program).deployment)).data);assert.equal(d.testMode,true);assert.equal(d.publisher,p);
  await assert.rejects(api.chainSubmit(db,ports,admin.publicKey.toBase58(),{intentId:prep.intentId,signedTransaction:tx.serialize().toString('base64')}),e=>e.code==='PLAN_STALE');
  await assert.rejects(api.chainPrepare(db,ports,{admin:admin.publicKey.toBase58(),action:'resume'}),e=>e.code==='SIMULATION_FAILED'&&/TooSoon|Data/.test(e.message));   // named program error (not paused)
 }finally{await db.close();}
});

test('opening credit: the API records the request; only the scheduler applies it, once, against the finalized balance',async()=>{
 const {db,api}=await setup();const admin=key(),dev=key(),mint=key();try{
  await api.registerPrimary(db,admin,{userId:crypto.randomUUID(),reboundWallets:[admin,dev]},{namespace:'mainnet_test',mint,fundingWallet:dev});
  const r=await api.openingCredit(db,admin,{mint,requestedCreditLamports:'1000000000',operationalReserveLamports:'100000000'});assert.equal(r.state,'requested');
  assert.equal((await db.query('SELECT count(*)::int n FROM reward_funding_accounts WHERE mint=$1',[mint])).rows[0].n,0,'nothing credited by the API');
  const conn={async getBalanceAndContext(){return{context:{slot:777},value:2_000_000_000};},async getBlockTime(){return 1_800_000_000;}};
  await db.query('SET ROLE rebound_scheduler');try{assert.deepEqual((await A.applyOpeningRequests(db,conn)).map(x=>x.state),['recorded']);assert.deepEqual(await A.applyOpeningRequests(db,conn),[]);}finally{await db.query('RESET ROLE');}
  const acct=(await db.query('SELECT * FROM reward_funding_accounts WHERE mint=$1',[mint])).rows[0];assert.equal(acct.credited,'1000000000');assert.equal(acct.holder_awaiting_transfer,'850000000');
  await assert.rejects(api.openingCredit(db,admin,{mint,requestedCreditLamports:'1',operationalReserveLamports:'0'}),e=>e.code==='ALREADY_RECORDED');
 }finally{await db.close();}
});

test('primary activation: the scheduler marks a registered primary active only after StartPrimary and exact agreement',async(t)=>{
 const fs=require('node:fs'),path=require('node:path');if(!fs.existsSync(path.join(__dirname,'../../contracts/v3/target/deploy/rebound_rewards_v3.so')))return t.skip('SBF build missing');
 const {SvmConnection}=require('./svm-connection.cjs'),{Transaction}=require('@solana/web3.js'),W3=require('../../server/rewards/wire-v3.cjs');
 const {db,api}=await setup();try{
  const admin=Keypair.generate(),program=Keypair.generate().publicKey,conn=new SvmConnection({program,admin:admin.publicKey});conn.airdrop(admin.publicKey,10n**10n);
  const mint=Keypair.generate().publicKey,dev=key(),other=key(),ports={connection:conn,program};
  const send=async ix=>{const bh=await conn.getLatestBlockhash();const tx=new Transaction({feePayer:admin.publicKey,...bh}).add(ix);tx.sign(admin);await conn.sendRawTransaction(tx.serialize());};
  await send(W3.I.initialize(program,{admin:admin.publicKey,programData:conn.programData,publisher:Keypair.generate().publicKey,verifier:Keypair.generate().publicKey,guardian:Keypair.generate().publicKey,policy:P3.hashOf(P3.TEST_POLICY),testMode:true}));
  const md=Buffer.alloc(82);md.writeBigUInt64LE(10n**15n,36);md[44]=6;md[45]=1;const {address:kitAddress}=require('@solana/kit');
  conn.svm.setAccount({address:kitAddress(mint.toBase58()),lamports:1_461_600n,programAddress:kitAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),executable:false,data:md,space:82n});
  await db.query("UPDATE reward_platform SET policy_version=$1 WHERE namespace='mainnet_test'",[P3.TEST_POLICY.version]);
  await api.registerPrimary(db,admin.publicKey.toBase58(),{userId:crypto.randomUUID(),reboundWallets:[dev]},{namespace:'mainnet_test',mint:mint.toBase58(),fundingWallet:dev});
  const sync=async()=>{await db.query('SET ROLE rebound_scheduler');try{return await A.syncPrimary(db,ports);}finally{await db.query('RESET ROLE');}};
  const status=async()=>(await db.query('SELECT status,blocked_reason FROM reward_coins WHERE mint=$1',[mint.toBase58()])).rows[0];
  assert.deepEqual((await sync()).map(r=>r.state),['waiting_for_start']);                          // nothing on chain yet
  await send(W3.I.registerPrimary(program,{admin:admin.publicKey,mint,fundingWallet:new (require('@solana/web3.js').PublicKey)(other)}));
  await send(W3.I.startPrimary(program,{admin:admin.publicKey,mint}));
  assert.deepEqual((await sync()).map(r=>r.state),['blocked']);                                    // chain names a different dev wallet
  assert.match((await status()).blocked_reason,/funding wallet/);assert.equal((await status()).status,'registered');
  await send(W3.I.setFundingWallet(program,{admin:admin.publicKey,mint,fundingWallet:new (require('@solana/web3.js').PublicKey)(dev)}));
  assert.deepEqual((await sync()).map(r=>r.state),['active']);
  assert.deepEqual(await status(),{status:'active',blocked_reason:null});
  assert.deepEqual(await sync(),[],'idempotent');
 }finally{await db.close();}
});
