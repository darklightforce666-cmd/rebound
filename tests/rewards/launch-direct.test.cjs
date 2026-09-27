'use strict';
// Launchpad without the on-chain program, against the REAL Pump programs (cloned mainnet binaries in
// LiteSVM): the user signs the creation, the coin's pump.fun creator is its REBOUND creator wallet, the worker
// sweeps its creator fees, the income ledger splits them 85/15, and the 15 % buys and burns the REBOUND token.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Keypair,PublicKey,Transaction}=require('@solana/web3.js');
const {getAssociatedTokenAddressSync,TOKEN_2022_PROGRAM_ID}=require('@solana/spl-token');
const {ready,world,SOL}=require('./pump-world.cjs'),{supabaseDb}=require('./pg.cjs');
const LD=require('../../server/rewards/launch-direct.cjs'),TP=require('../../server/rewards/third-party-direct.cjs'),PV=require('../../server/rewards/pump-v3.cjs');
const PSDK=require('@pump-fun/pump-sdk');
const Admin=require('../../server/rewards/admin-v3.cjs'),Wk=require('../../server/rewards/worker-v3.cjs'),H=require('../../server/rewards/history-v3.cjs');
const t=ready?test:(name,fn)=>test(name,{skip:'needs contracts/v3/fixtures/mainnet (clone-protocol.cjs) and the SBF build'},fn);
process.env.REWARDS_MAX_EXECUTION_MODE='mainnet_test';

async function setup(){
 const w=await world(),db=await supabaseDb();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rebound-ld-')),key=path.join(dir,'master.key');fs.writeFileSync(key,crypto.randomBytes(32).toString('hex'),{mode:0o600});
 process.env.REWARDS_SIGNER_MASTER_KEY_FILE=key;
 const user=w.user.publicKey.toBase58(),primary=w.primary.toBase58();
 await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES($1,'h','active','primary','mainnet_test','v3','rebound-v3.2-test')",[primary]);
 await db.query("UPDATE reward_platform SET execution_mode='mainnet_test',paused=false,primary_mint=$1,test_allowlist_wallets=ARRAY[$2],spend_cap_action_lamports=$3,spend_cap_cycle_lamports=$3,spend_cap_total_lamports=$3 WHERE namespace='mainnet_test'",[primary,user,String(1000n*SOL)]);
 await db.query("INSERT INTO reward_assets(hash,kind,bucket,path,mime,bytes,public_url,created_by) VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','metadata','m','x.json','application/json',10,'https://rebound.wtf/m/x.json',gen_random_uuid())");
 await TP.ensureCreatorWallets(db,{env:process.env});
 const session={userId:crypto.randomUUID(),wallets:[user],reboundWallets:[user]};
 const ports={db,connection:w.conn};
 return{w,db,ports,session,user,primary,done:async()=>{await db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

t('a launch creates a pump.fun coin whose creator is its REBOUND creator wallet; fees are swept, split 85/15, and 15 % burns the REBOUND token',async()=>{
 const s=await setup();try{
  const {w,db,ports,session}=s;
  assert.equal((await db.query("SELECT count(*)::int n FROM reward_creator_wallets WHERE status='available'")).rows[0].n,TP.POOL_SIZE);
  const a=await LD.draft(ports,{session,wallet:s.user,idempotencyKey:'launch-test-0001',metadataHash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'Direct coin',symbol:'DRC',initialBuyLamports:0n,namespace:'mainnet_test'});
  assert.equal(a.settlement,'direct');
  const mintKp=Keypair.generate();
  const p=await LD.prepare(ports,{session,attemptId:a.id,mint:mintKp.publicKey.toBase58()});
  assert.equal(p.settlement,'direct');const creator=p.disclosure.commissionTreasury;
  const tx=Transaction.from(Buffer.from(p.transactions[0],'base64'));tx.partialSign(w.user,mintKp);
  const sub=await LD.submit(ports,{session,attemptId:a.id,signedTransaction:tx.serialize().toString('base64')});assert.ok(sub.signature);
  w.conn.advance({slots:2,seconds:2});w.conn.finalizeAll();
  const st=await LD.status(ports,{session,attemptId:a.id});assert.equal(st.state,'active',JSON.stringify(st));
  const mint=mintKp.publicKey;
  const bc=PV.sdk.decodeBondingCurve(w.conn._info(PV.SDK.bondingCurvePda(mint)));assert.equal(bc.creator.toBase58(),creator,'the pump.fun creator is the REBOUND creator wallet');
  const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint.toBase58()])).rows[0];
  assert.equal(coin.kind,'third_party');assert.equal(coin.status,'active');assert.equal(coin.intake,creator);
  const fw=(await db.query('SELECT * FROM reward_funding_wallets WHERE mint=$1',[mint.toBase58()])).rows[0];assert.equal(fw.address,creator);assert.equal(fw.funding_model,'income');assert.equal(fw.mode,'automatic');
  assert.equal(BigInt(await w.conn.getBalance(new PublicKey(creator))),LD.OPERATING_LAMPORTS,'the creator wallet received its operating SOL');
  // The worker opens the income ledger at the creation (the operating SOL is not income).
  await Admin.applyOpeningRequests(db,w.conn);
  // Trading accrues creator fees in the creator's pump.fun vault.
  for(let i=0;i<6;i++)await w.buy(mint,w.trader,10n*SOL);
  const coin2=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint.toBase58()])).rows[0],fw2=(await db.query('SELECT * FROM reward_funding_wallets WHERE mint=$1',[mint.toBase58()])).rows[0];
  const before=BigInt(await w.conn.getBalance(new PublicKey(creator)));
  const vault=BigInt((await new PSDK.OnlinePumpSdk(w.conn).getCreatorVaultBalanceBothPrograms(new PublicKey(creator))).toString());assert.ok(vault>1_000_000n,'creator fees accrued: '+vault);
  const c=await TP.collectFees({db,connection:w.conn,env:process.env},coin2,fw2);assert.ok(['submitted','finalized'].includes(c.state),JSON.stringify(c));
  w.conn.advance({slots:1,seconds:1});w.conn.finalizeAll();
  const collected=BigInt(await w.conn.getBalance(new PublicKey(creator)))-before;assert.ok(collected>1_000_000n,'fees swept into the creator wallet: '+collected);
  // Income reconciliation: the sweep is income, split once 85/15.
  await Wk.reconcileFunding({db,rpc:w.conn.rpc(),program:null},coin2);
  const acc=(await db.query('SELECT * FROM reward_funding_accounts WHERE mint=$1',[mint.toBase58()])).rows[0];
  // Income = everything the vaults paid out; the fee and the WSOL account rent come out of the operating SOL.
  assert.equal(BigInt(acc.credited),vault,'the whole sweep is income; the operating SOL is not');
  assert.ok(vault-collected<=5000n+2_039_280n,'only the fee and a token-account rent left the wallet: '+(vault-collected));
  assert.equal(BigInt(acc.holder_awaiting_transfer)+BigInt(acc.other_settled),vault);
  assert.equal(BigInt(acc.holder_awaiting_transfer),vault*85n/100n,'85 % to holders');
  assert.ok(BigInt(acc.other_settled)>=TP.MIN_BURN,'15 % is enough to burn: '+acc.other_settled);
  // 15 %: buy the REBOUND token and burn it, in one transaction.
  const supplyBefore=w.supply(w.primary);
  const bn=await TP.burn({db,connection:w.conn,env:process.env},coin2,fw2);assert.ok(['submitted','finalized'].includes(bn.state),JSON.stringify(bn));
  w.conn.advance({slots:1,seconds:1});w.conn.finalizeAll();
  assert.ok(w.supply(w.primary)<supplyBefore,'REBOUND token supply fell: burned');
  const holding=getAssociatedTokenAddressSync(w.primary,new PublicKey(creator),true,TOKEN_2022_PROGRAM_ID);
  assert.ok(w.tokenBalance(holding)<=w.supply(w.primary),'');
  await TP.burn({db,connection:w.conn,env:process.env},coin2,fw2);
  const row=(await db.query('SELECT * FROM reward_burns WHERE mint=$1',[mint.toBase58()])).rows[0];assert.equal(row.state,'burned');
  // The burn spends the 15 % share less what the wallet's own costs took (fees, a token-account rent); the rest
  // waits for the next burn. The holders' 85 % is never touched.
  assert.ok(BigInt(row.lamports)<=BigInt(acc.other_settled)&&BigInt(acc.other_settled)-BigInt(row.lamports)<=2_039_280n+20_000n,'the 15 % share was spent: '+row.lamports+' of '+acc.other_settled);
  // The holders' 85 % is still on the wallet (the burn never touches it).
  assert.ok(BigInt(await w.conn.getBalance(new PublicKey(creator)))>=BigInt(acc.holder_awaiting_transfer));
 }finally{await s.done();}
});

t('launch safety: the pair is fixed once prepared, registration is idempotent, only the assigned launch_creator key signs, unused reservations return to the pool',async()=>{
 const s=await setup();try{
  const {w,db,ports,session}=s;const Signer=require('../../server/rewards/signer.cjs');
  const args={session,wallet:s.user,idempotencyKey:'launch-test-0002',metadataHash:'a'.repeat(64),name:'Safe coin',symbol:'SAFE',initialBuyLamports:0n,namespace:'mainnet_test'};
  const a=await LD.draft(ports,args);const mintKp=Keypair.generate();
  const p=await LD.prepare(ports,{session,attemptId:a.id,mint:mintKp.publicKey.toBase58()});const creator=p.disclosure.commissionTreasury;
  // Re-drafting with another pair after prepare changes nothing: the signed intent decides.
  const again=await LD.draft(ports,{...args,quoteMint:Keypair.generate().publicKey.toBase58()});assert.equal(again.id,a.id);assert.equal(again.quote_mint,null);
  const tx=Transaction.from(Buffer.from(p.transactions[0],'base64'));tx.partialSign(w.user,mintKp);
  await LD.submit(ports,{session,attemptId:a.id,signedTransaction:tx.serialize().toString('base64')});
  w.conn.advance({slots:1,seconds:1});w.conn.finalizeAll();
  // A repeated registration is a no-op (concurrent polls serialize on the attempt row lock; PGlite is one session).
  const x=await LD.status(ports,{session,attemptId:a.id});await db.query("UPDATE reward_launch_attempts SET state='creation_submitted' WHERE id=$1",[a.id]);
  const y=await LD.register(ports,(await db.query('SELECT * FROM reward_launch_attempts WHERE id=$1',[a.id])).rows[0],(await db.query("SELECT signature FROM reward_chain_attempts WHERE job=$1",[`launch:${a.id}:0`])).rows[0].signature).then(()=>LD.status(ports,{session,attemptId:a.id}));
  assert.equal(x.state,'active');assert.equal(y.state,'active');assert.equal(x.rewards,'active');
  const mint=mintKp.publicKey.toBase58();
  assert.equal((await db.query('SELECT count(*)::int n FROM reward_funding_wallets WHERE mint=$1',[mint])).rows[0].n,1);
  const cw=(await db.query('SELECT * FROM reward_creator_wallets WHERE address=$1',[creator])).rows[0];assert.equal(cw.status,'assigned');assert.equal(cw.mint,mint);
  await Admin.applyOpeningRequests(db,w.conn);
  const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0],fw=(await db.query('SELECT * FROM reward_funding_wallets WHERE mint=$1',[mint])).rows[0];
  assert.ok(fw.opening_slot!=null,'the income ledger opened at the creation');
  await w.buy(mintKp.publicKey,w.trader,10n*SOL);
  // A funding wallet pointed at any other key (here a fee_payer key) is refused before anything is signed.
  const kp=Keypair.generate(),other=await Signer.importSigner(db,{role:'fee_payer',secretText:JSON.stringify(Array.from(kp.secretKey)),expectedAddress:kp.publicKey.toBase58(),env:process.env});
  await assert.rejects(()=>TP.collectFees({db,connection:w.conn,env:process.env},coin,{...fw,signer:other.id}),e=>e.code==='SIGNER_MISMATCH');
  await assert.rejects(()=>TP.collectFees({db,connection:w.conn,env:process.env},{...coin,mint:Keypair.generate().publicKey.toBase58()},fw),e=>e.code==='SIGNER_MISMATCH');
  // An abandoned reservation (never used on chain) returns to the pool; the assigned wallet never does.
  const b=await LD.draft(ports,{...args,idempotencyKey:'launch-test-0003'});
  await LD.prepare(ports,{session,attemptId:b.id,mint:Keypair.generate().publicKey.toBase58()});
  const held=(await db.query('SELECT address FROM reward_creator_wallets WHERE attempt_id=$1',[b.id])).rows[0].address;
  await db.query("UPDATE reward_creator_wallets SET reserved_at=now()-interval '1 hour' WHERE status IN ('reserved','assigned')");
  assert.equal(await TP.releaseUnused(db,w.conn),1);
  assert.equal((await db.query('SELECT status FROM reward_creator_wallets WHERE address=$1',[held])).rows[0].status,'available');
  assert.equal((await db.query('SELECT status FROM reward_creator_wallets WHERE address=$1',[creator])).rows[0].status,'assigned');
 }finally{await s.done();}
});

test('launch roles: the API reserves only through the function and cannot rewrite creator wallets; the scheduler can throttle, refill and burn',async()=>{
 const {as}=require('./pg.cjs');const db=await supabaseDb();try{
  const s=await db.query("INSERT INTO reward_signers(id,address,role,storage,external_reference) VALUES(gen_random_uuid(),'CreatorAddr1','launch_creator','managed','test') RETURNING id");
  await db.query("INSERT INTO reward_creator_wallets(address,signer) VALUES('CreatorAddr1',$1)",[s.rows[0].id]);
  const att=crypto.randomUUID();
  await db.query("INSERT INTO reward_launch_attempts(id,wallet,state,request_hash,metadata_uri,metadata_hash,user_id,idempotency_key,namespace) VALUES($1,'W','draft','h','https://x/m.json','h',gen_random_uuid(),'k-roles','mainnet_test')",[att]);
  await as(db,'rebound_api',null,async d=>{
   assert.equal((await d.query('SELECT reward_reserve_creator_wallet($1) a',[att])).rows[0].a,'CreatorAddr1');
   await assert.rejects(()=>d.query("UPDATE reward_creator_wallets SET status='available'"));});
  await as(db,'rebound_scheduler',null,async d=>{
   await d.query("UPDATE reward_creator_wallets SET collected_at=now() WHERE address='CreatorAddr1'");
   await d.query("SELECT count(*) FROM reward_burns");});
 }finally{await db.close();}
});
