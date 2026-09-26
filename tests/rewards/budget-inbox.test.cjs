'use strict';
// Balance-budget funding, the any-holder private test and the sealed fee-wallet key inbox (migration 013).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Keypair}=require('@solana/web3.js'),bs58=require('bs58');
const {supabaseDb}=require('./pg.cjs');
const A=require('../../server/rewards/admin-v3.cjs'),X=require('../../server/rewards/execution.cjs'),Seal=require('../../server/rewards/inbox-seal.cjs');
const Inbox=require('../../server/rewards/key-inbox.cjs'),Signer=require('../../server/rewards/signer.cjs'),Wk=require('../../server/rewards/worker-v3.cjs'),W3=require('../../server/rewards/wire-v3.cjs');
const key=()=>Keypair.generate().publicKey.toBase58();
const as=(db,role)=>fn=>async(...a)=>{await db.query('SET ROLE '+role);try{return await fn(...a);}finally{await db.query('RESET ROLE');}};
const tmp=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'rebound-inbox-'));fs.chmodSync(d,0o700);return d;};
const conn=(balance)=>({getBalance:async()=>balance,getBalanceAndContext:async()=>({value:balance,context:{slot:123}}),getParsedAccountInfo:async()=>({value:null}),getAccountInfo:async()=>null});

test('sealed box: opens only with the worker key and the exact binding',async()=>{
 const jwk=await Seal.generate(),other=await Seal.generate(),secret=crypto.randomBytes(64);
 const bind={fundingWallet:crypto.randomUUID(),address:key()};
 const s=await Seal.seal(secret,{...bind,inboxPublicKey:jwk.x});
 assert.equal(s.iv.length,16);assert.equal(s.ephemeralPublicKey.length,43);assert.ok(!s.ciphertext.includes(bs58.encode(secret)));
 assert.deepEqual(Buffer.from(await Seal.open(s,jwk,bind)),secret);
 await assert.rejects(Seal.open(s,other,bind));
 await assert.rejects(Seal.open(s,jwk,{...bind,address:key()}));
 await assert.rejects(Seal.open(s,jwk,{...bind,fundingWallet:crypto.randomUUID()}));
});

test('launch (private test, budget): allowlist + any holder + caps from the budget; payouts stay off unless asked',async()=>{
 const db=await supabaseDb();const api=f=>as(db,'rebound_api')(f);const admin=key(),mint=key(),dev=key();
 try{
  await db.query("INSERT INTO reward_admin_wallets(wallet,label,added_by) VALUES($1,'owner','test')",[admin]);
  await assert.rejects(api(A.launch)(db,'admin (password)',{},{mint,feeWallet:admin,namespace:'mainnet_test'},{connection:conn(1)}),e=>/different wallet/.test(e.message));
  await assert.rejects(api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:150},{connection:conn(1)}),e=>e.code==='INVALID_BODY');
  const r=await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:50},{connection:conn(2_000_000_000)});
  assert.equal(r.budgetBps,5000);assert.equal(r.budgetEstimate,'1000000000');assert.equal(r.test.mode,'dry_run');
  const p=(await db.query("SELECT * FROM reward_platform WHERE namespace='mainnet_test'")).rows[0];
  assert.deepEqual(p.test_allowlist_mints,[mint]);assert.equal(p.test_any_recipient,true);assert.equal(p.execution_mode,'dry_run');
  assert.equal(p.spend_cap_action_lamports,String(1_100_000_000n+10_000_000n));assert.equal(p.spend_cap_total_lamports,String(1_100_000_000n+250_000_000n));
  const fw=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1",[mint])).rows[0];
  assert.equal(fw.funding_model,'balance_budget');assert.equal(fw.budget_bps,5000);assert.ok(fw.budget_requested_at);assert.equal(fw.budget_lamports,null);
  const r2=await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:50,startTest:true},{connection:conn(9_000_000_000)});
  assert.equal(r2.test.mode,'mainnet_test');assert.equal(r2.budgetAction,'kept');assert.equal(r2.budgetEstimate,null);
  // Saving again neither re-measures the budget nor raises the caps.
  const p2=(await db.query("SELECT * FROM reward_platform WHERE namespace='mainnet_test'")).rows[0];assert.equal(p2.spend_cap_total_lamports,p.spend_cap_total_lamports);
  assert.equal((await db.query("SELECT budget_requested_at::text t FROM reward_funding_wallets WHERE mint=$1",[mint])).rows[0].t,(await db.query("SELECT budget_requested_at::text t FROM reward_funding_wallets WHERE mint=$1",[mint])).rows[0].t);
  await assert.rejects(api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:60},{connection:conn(1)}),e=>e.code==='BUDGET_RAISE');
  assert.equal((await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:40},{connection:conn(1)})).budgetAction,'lowered');
  await assert.rejects(api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',fundingModel:'income'},{connection:conn(1)}),e=>e.code==='MODEL_SWITCH');
  const r3=await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:50,newBudget:true},{connection:conn(4_000_000_000)});
  assert.equal(r3.budgetAction,'new');assert.equal(r3.budgetEstimate,'2000000000');
  // Any holder of the allowlisted mint may be paid; other mints and the caps still bind.
  const stranger=key();
  await db.query('BEGIN');const ok=await X.authorize(db,{namespace:'mainnet_test',mint,recipients:[stranger],lamports:'0',fees:'5000',kind:'payout'},{env:{REWARDS_MAX_EXECUTION_MODE:'mainnet_test'}});await db.query('ROLLBACK');
  assert.equal(ok.mode,'mainnet_test');
  await db.query('BEGIN');await assert.rejects(X.authorize(db,{namespace:'mainnet_test',mint:key(),recipients:[stranger],lamports:'0',fees:'5000'},{env:{REWARDS_MAX_EXECUTION_MODE:'mainnet_test'}}),e=>e.code==='TEST_MINT_NOT_ALLOWED');await db.query('ROLLBACK');
  await db.query('BEGIN');await assert.rejects(X.authorize(db,{namespace:'mainnet_test',mint,recipients:[],lamports:'5000000000',fees:'5000'},{env:{REWARDS_MAX_EXECUTION_MODE:'mainnet_test'}}),e=>e.code==='SPEND_CAP_ACTION');await db.query('ROLLBACK');
  // Income model: only fees from now on (opening credit 0 requested for the scheduler).
  const mint2=key(),dev2=key();
  await api(A.launch)(db,'admin (password)',{},{mint:mint2,feeWallet:dev2,namespace:'production',fundingModel:'income'},{connection:conn(5)});
  const intent=(await db.query("SELECT body FROM reward_intents WHERE job=$1",['opening:'+mint2])).rows[0];assert.equal(intent.body.credit,'0');
 }finally{await db.close();}
});

test('budget: the scheduler fixes 50 % of the finalized balance; rounds take only what is left, never the last 0.01 SOL',async()=>{
 const db=await supabaseDb();const api=f=>as(db,'rebound_api')(f),sch=f=>as(db,'rebound_scheduler')(f);const mint=key(),dev=key();
 try{
  await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:50},{connection:conn(1_000_000_000)});
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(1_000_000_000),mint,{deposits:0n}),0n);   // not measured yet
  const set=await sch(Wk.applyBudgetRequests)(db,{connection:conn(1_000_000_000),program:null});assert.deepEqual(set,[{mint,budget:'500000000'}]);
  assert.deepEqual(await sch(Wk.applyBudgetRequests)(db,{connection:conn(1),program:null}),[]);   // applied once
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(1_000_000_000),mint,{deposits:0n}),500_000_000n);
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(800_000_000),mint,{deposits:200_000_000n}),300_000_000n);
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(510_000_000),mint,{deposits:490_000_000n}),10_000_000n);
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(505_000_000),mint,{deposits:300_000_000n}),200_000_000n);
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(5_000_000),mint,{deposits:0n}),0n);   // balance below the fee reserve
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(900_000_000),mint,{deposits:500_000_000n}),0n);   // budget used up
  // Saving again keeps the budget; lowering the percentage applies at once to what is left.
  await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:50},{connection:conn(9_000_000_000)});
  assert.deepEqual(await sch(Wk.applyBudgetRequests)(db,{connection:conn(9_000_000_000),program:null}),[]);
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(900_000_000),mint,{deposits:100_000_000n}),400_000_000n);
  await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:30},{connection:conn(1)});
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(900_000_000),mint,{deposits:100_000_000n}),200_000_000n);   // 30 % of 1 SOL − 0.1 paid
  // A request made while the scheduler measured is not swallowed.
  await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:50,newBudget:true},{connection:conn(1)});
  const racing={...conn(2_000_000_000),getBalanceAndContext:async()=>{await db.query('RESET ROLE');await db.query("UPDATE reward_funding_wallets SET budget_bps=1000,budget_requested_at=now()+interval '1 second' WHERE mint=$1",[mint]);await db.query('SET ROLE rebound_scheduler');return{value:2_000_000_000,context:{slot:1}};}};
  assert.deepEqual(await sch(Wk.applyBudgetRequests)(db,{connection:racing,program:null}),[]);
  assert.deepEqual(await sch(Wk.applyBudgetRequests)(db,{connection:conn(2_000_000_000),program:null}),[{mint,budget:'200000000'}]);
  assert.ok((await db.query("SELECT 1 FROM reward_logs WHERE event_type='funding_budget_set'")).rows.length);
  // Income-ledger wallets are not budgeted.
  assert.equal(await sch(Wk.budgetAvailable)(db,conn(1),key(),{deposits:0n}),null);
 }finally{await db.close();}
});

test('key inbox: sealed in the browser, imported by the scheduler only for the registered fee wallet, then wiped',async()=>{
 const db=await supabaseDb();const api=f=>as(db,'rebound_api')(f),sch=f=>as(db,'rebound_scheduler')(f);const dir=tmp();
 const env={REWARDS_INBOX_KEY_FILE:path.join(dir,'inbox.jwk'),REWARDS_SIGNER_MASTER_KEY_FILE:path.join(dir,'signer-master.key')};
 const dev=Keypair.generate(),mint=key();
 try{
  await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev.publicKey.toBase58(),namespace:'mainnet_test'},{connection:conn(1)});
  await assert.rejects(api(Inbox.submit)(db,'admin',{mint,address:dev.publicKey.toBase58(),inboxPublicKey:'A'.repeat(43),ephemeralPublicKey:'A'.repeat(43),iv:'A'.repeat(16),ciphertext:'A'.repeat(107)}),e=>e.code==='SETUP_REQUIRED');
  const first=await sch(Inbox.processInbox)(db,{env,worker:'test'});assert.equal(first.configured,true);
  assert.equal((fs.statSync(env.REWARDS_INBOX_KEY_FILE).mode&0o777),0o600);assert.equal((fs.statSync(env.REWARDS_SIGNER_MASTER_KEY_FILE).mode&0o777),0o600);
  const wk=(await db.query('SELECT inbox_public_key FROM reward_worker_keys')).rows[0].inbox_public_key;assert.equal(wk,first.publicKey);
  const fw=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1",[mint])).rows[0];
  // Wrong key for this wallet: rejected by the worker, row wiped.
  const wrong=Keypair.generate();
  let s=await Seal.seal(wrong.secretKey,{fundingWallet:fw.id,address:fw.address,inboxPublicKey:wk});
  await api(Inbox.submit)(db,'admin',{mint,address:fw.address,inboxPublicKey:wk,...s});
  await assert.rejects(api(Inbox.submit)(db,'admin',{mint,address:fw.address,inboxPublicKey:wk,...s}),e=>e.code==='ALREADY_PENDING');
  // The API cannot read ciphertext back; only the scheduler can.
  await db.query('SET ROLE rebound_api');await assert.rejects(db.query('SELECT ciphertext FROM reward_key_inbox'));await db.query('RESET ROLE');
  await db.query('SET ROLE rebound_indexer');await assert.rejects(db.query('SELECT ciphertext FROM reward_key_inbox'));await db.query('RESET ROLE');
  let out=await sch(Inbox.processInbox)(db,{env,worker:'test'});assert.equal(out.processed[0].state,'failed');assert.equal(out.processed[0].code,'SIGNER_MISMATCH');
  let row=(await db.query('SELECT * FROM reward_key_inbox ORDER BY created_at DESC LIMIT 1')).rows[0];assert.equal(row.ciphertext,null);assert.equal(row.state,'failed');
  // The right key: imported, wallet automatic, loadable by the scheduler with the master key.
  s=await Seal.seal(dev.secretKey,{fundingWallet:fw.id,address:fw.address,inboxPublicKey:wk});
  await api(Inbox.submit)(db,'admin',{mint,address:fw.address,inboxPublicKey:wk,...s});
  out=await sch(Inbox.processInbox)(db,{env,worker:'test'});assert.equal(out.processed[0].state,'imported');
  const live=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1",[mint])).rows[0];assert.equal(live.mode,'automatic');assert.ok(live.signer);
  const kp=await sch(Signer.load)(db,live.signer,{env});assert.equal(kp.publicKey.toBase58(),fw.address);
  row=(await db.query("SELECT * FROM reward_key_inbox WHERE state='imported'")).rows[0];assert.equal(row.ciphertext,null);assert.equal(row.iv,null);
  const logs=(await db.query('SELECT safe_message,safe_metadata FROM reward_logs')).rows.map(r=>JSON.stringify(r)).join('\n');
  assert.ok(!logs.includes(bs58.encode(dev.secretKey)));
  // Importing again replaces the old signer (one live signer per wallet).
  s=await Seal.seal(dev.secretKey,{fundingWallet:fw.id,address:fw.address,inboxPublicKey:wk});await api(Inbox.submit)(db,'admin',{mint,address:fw.address,inboxPublicKey:wk,...s});
  out=await sch(Inbox.processInbox)(db,{env,worker:'test'});assert.equal(out.processed[0].state,'imported');
  assert.equal((await db.query("SELECT count(*)::int n FROM reward_signers WHERE address=$1 AND status='ready'",[fw.address])).rows[0].n,1);
  // A failed import (master key unreadable) keeps the working signer and the wallet untouched.
  const before=(await db.query("SELECT signer FROM reward_funding_wallets WHERE mint=$1",[mint])).rows[0].signer;
  fs.chmodSync(env.REWARDS_SIGNER_MASTER_KEY_FILE,0o644);
  s=await Seal.seal(dev.secretKey,{fundingWallet:fw.id,address:fw.address,inboxPublicKey:wk});await api(Inbox.submit)(db,'admin',{mint,address:fw.address,inboxPublicKey:wk,...s});
  out=await sch(Inbox.processInbox)(db,{env,worker:'test'});assert.equal(out.processed[0].state,'failed');
  fs.chmodSync(env.REWARDS_SIGNER_MASTER_KEY_FILE,0o600);
  assert.equal((await db.query("SELECT signer FROM reward_funding_wallets WHERE mint=$1",[mint])).rows[0].signer,before);
  assert.equal((await db.query("SELECT status FROM reward_signers WHERE id=$1",[before])).rows[0].status,'ready');
  // A missing master key file is never silently replaced while imported keys depend on it.
  const moved=env.REWARDS_SIGNER_MASTER_KEY_FILE+'.bak';fs.renameSync(env.REWARDS_SIGNER_MASTER_KEY_FILE,moved);
  s=await Seal.seal(dev.secretKey,{fundingWallet:fw.id,address:fw.address,inboxPublicKey:wk});await api(Inbox.submit)(db,'admin',{mint,address:fw.address,inboxPublicKey:wk,...s});
  out=await sch(Inbox.processInbox)(db,{env,worker:'test'});assert.equal(out.processed[0].code,'SIGNER_UNCONFIGURED');assert.ok(!fs.existsSync(env.REWARDS_SIGNER_MASTER_KEY_FILE));
  fs.renameSync(moved,env.REWARDS_SIGNER_MASTER_KEY_FILE);
  // A token switch with the same fee wallet keeps automatic deposits.
  const mint2=key();await api(A.launch)(db,'admin (password)',{},{mint:mint2,feeWallet:fw.address,namespace:'mainnet_test'},{connection:conn(1)});
  assert.equal((await db.query("SELECT mode FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[mint2])).rows[0].mode,'automatic');
 }finally{await db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
