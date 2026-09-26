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
  const r2=await api(A.launch)(db,'admin (password)',{},{mint,feeWallet:dev,namespace:'mainnet_test',budgetPercent:50,startTest:true},{connection:conn(2_000_000_000)});
  assert.equal(r2.test.mode,'mainnet_test');
  // Any holder of the allowlisted mint may be paid; other mints and the caps still bind.
  const stranger=key();
  await db.query('BEGIN');const ok=await X.authorize(db,{namespace:'mainnet_test',mint,recipients:[stranger],lamports:'0',fees:'5000',kind:'payout'},{env:{REWARDS_MAX_EXECUTION_MODE:'mainnet_test'}});await db.query('ROLLBACK');
  assert.equal(ok.mode,'mainnet_test');
  await db.query('BEGIN');await assert.rejects(X.authorize(db,{namespace:'mainnet_test',mint:key(),recipients:[stranger],lamports:'0',fees:'5000'},{env:{REWARDS_MAX_EXECUTION_MODE:'mainnet_test'}}),e=>e.code==='TEST_MINT_NOT_ALLOWED');await db.query('ROLLBACK');
  await db.query('BEGIN');await assert.rejects(X.authorize(db,{namespace:'mainnet_test',mint,recipients:[],lamports:'2000000000',fees:'5000'},{env:{REWARDS_MAX_EXECUTION_MODE:'mainnet_test'}}),e=>e.code==='SPEND_CAP_ACTION');await db.query('ROLLBACK');
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
  // A token switch with the same fee wallet keeps automatic deposits.
  const mint2=key();await api(A.launch)(db,'admin (password)',{},{mint:mint2,feeWallet:fw.address,namespace:'mainnet_test'},{connection:conn(1)});
  assert.equal((await db.query("SELECT mode FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[mint2])).rows[0].mode,'automatic');
 }finally{await db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
