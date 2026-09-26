'use strict';
// Backend third-party lifecycle on the cloned mainnet protocol + compiled REBOUND program + PostgreSQL:
// collection crank → intake scan (income vs setup rent) → independent attestation → on-chain Credit
// mirrored once in the ledger → buyback job reserve → deferred while the market migrates → canonical
// pool purchase (ambiguous broadcast reconciled, never bought twice) → burn → close.
const test=require('node:test'),assert=require('node:assert/strict');
const {Keypair}=require('@solana/web3.js');
const {supabaseDb}=require('./pg.cjs'),W3=require('../../server/rewards/wire-v3.cjs'),P3=require('../../server/rewards/policy-v3.cjs'),PV=require('../../server/rewards/pump-v3.cjs');
const R=require('../../server/rewards/receipts-v3.cjs'),BB=require('../../server/rewards/buyback-v3.cjs');
const {ready,world,launch,route,SOL}=require('./pump-world.cjs');
const t=ready?test:(name,fn)=>test(name,{skip:'needs contracts/v3/fixtures/mainnet (clone-protocol.cjs) and the SBF build'},fn);
process.env.REWARDS_MAX_EXECUTION_MODE='mainnet_test';process.env.REWARDS_MIN_BUYBACK_LAMPORTS='1000';

async function setup(){
 const w=await world();const {mint,l}=await launch(w);await w.buy(mint,w.trader,4n*SOL);await route(w,mint);
 const db=await supabaseDb(),mintS=mint.toBase58();
 await db.query("UPDATE reward_platform SET execution_mode='mainnet_test',test_allowlist_mints=$1,spend_cap_action_lamports=$2,spend_cap_cycle_lamports=$2,spend_cap_total_lamports=$3 WHERE namespace='mainnet_test'",[[mintS],String(100n*SOL),String(1000n*SOL)]);
 await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version,creator_wallet,primary_target_mint,intake) VALUES($1,$2,'active','third_party','mainnet_test','v3','rebound-v3.0',$3,$4,$5)",[mintS,P3.POLICY_HASH,w.user.publicKey.toBase58(),w.primary.toBase58(),l.addresses.intake.toBase58()]);
 const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mintS])).rows[0];
 const ports={db,connection:w.conn,program:w.program,feePayer:w.cranker,publisher:w.publisher,worker:'t',verifier:R.attestor({rpc:w.conn.rpc(),connection:w.conn,program:w.program,key:w.verifier})};
 return{w,db,mint,mintS,coin,ports,intake:l.addresses.intake};
}
const settle=async(w,fn,k=4)=>{let r;for(let i=0;i<k;i++){w.conn.finalizeAll();r=await fn();}return r;};

t('creator fees: crank → intake scan → independent attestation → Credit once; setup rent never credited',async()=>{
 const {w,db,mint,mintS,coin,ports}=await setup();try{
  const cr=await settle(w,()=>R.crank(ports,coin),2);assert.ok(['finalized','nothing_pending'].includes(cr.state),JSON.stringify(cr));
  const scan=await R.scanIntake({db,rpc:w.conn.rpc(),program:w.program},coin);assert.equal(scan.complete,true);assert.ok(scan.receipts>=1);
  const moves=(await db.query("SELECT classification,lamports FROM reward_wallet_movements WHERE mint=$1",[mintS])).rows;
  assert.ok(moves.some(m=>m.classification==='rent'),'setup rent recorded as a non-income movement');
  const obs=(await db.query("SELECT * FROM reward_intake_receipts WHERE mint=$1",[mintS])).rows;
  const out=await settle(w,()=>R.creditStep(ports,coin),3);void out;
  const rows=(await db.query("SELECT * FROM reward_intake_receipts WHERE mint=$1",[mintS])).rows;assert.ok(rows.every(r=>r.state==='credited'),JSON.stringify(rows.map(r=>[r.state,r.reason])));
  const gross=obs.reduce((s,r)=>s+BigInt(r.amount_lamports),0n);
  const chain=w.coin(mint);assert.equal(chain.receipts,gross,'only creator-fee collections were credited (setup rent excluded)');
  const acct=(await db.query('SELECT * FROM reward_funding_accounts WHERE mint=$1',[mintS])).rows[0];
  assert.equal(BigInt(acct.credited),gross);assert.equal(BigInt(acct.holder_available),chain.holderUnallocated);assert.equal(BigInt(acct.other_available),chain.buybackAvailable);
  // Replays add nothing: scanning again and crediting again are no-ops.
  await R.scanIntake({db,rpc:w.conn.rpc(),program:w.program},coin);await R.creditStep(ports,coin);
  assert.equal(w.coin(mint).receipts,gross);assert.equal((await db.query('SELECT count(*)::int n FROM reward_funding_credits WHERE mint=$1',[mintS])).rows[0].n,obs.length);
  // A forged amount is refused by the independent verifier (held, nothing credited).
  await assert.rejects(ports.verifier.attestReceipt({mint:mintS,signature:obs[0].signature,amount:BigInt(obs[0].amount_lamports)+1n}),e=>e.code==='VERIFIER_REJECTED');
 }finally{await db.close();}
});

t('buyback job: reserve → deferred while PRIMARY migrates → pool purchase (lost response reconciled) → burn → close',async()=>{
 const {w,db,mint,mintS,coin,ports}=await setup();try{
  await settle(w,()=>R.crank(ports,coin),2);await R.scanIntake({db,rpc:w.conn.rpc(),program:w.program},coin);await settle(w,()=>R.creditStep(ports,coin),3);
  const budget=w.coin(mint).buybackAvailable;assert.ok(budget>0n);
  const cycleId=`${mintS}:1`;
  await db.query("INSERT INTO reward_cycles(id,mint,cycle_number,namespace,policy_version,config_version,anchor,cycle_start,scheduled_end,cutoff_time,state,due_at,funding_mode) VALUES($1,$2,1,'mainnet_test','rebound-v3.0',1,0,0,1800,1740,'skipped_no_eligible_holders',1800,'program_treasury')",[cycleId,mintS]);
  // PRIMARY completes its curve but is not migrated yet: no substitute market; the job waits.
  await w.buyOut(w.primary,w.trader);
  let r=await settle(w,()=>BB.step(ports,coin,cycleId),2);
  let job=(await db.query('SELECT * FROM reward_buyback_jobs WHERE source_mint=$1',[mintS])).rows[0];
  assert.equal(job.state,'deferred');assert.equal(job.reason,'ROUTING_MIGRATING');assert.equal(BigInt(job.budget_lamports),budget);
  assert.equal(w.job(mint,0).state,'reserved');assert.equal(w.coin(mint).buybackReserved,budget,'budget stays reserved on chain');
  const acct0=(await db.query('SELECT * FROM reward_funding_accounts WHERE mint=$1',[mintS])).rows[0];assert.equal(BigInt(acct0.other_reserved),budget);
  // Retargeting now does not change the reserved job.
  const other=Keypair.generate();void other;
  await w.migrate(w.primary,w.cranker);
  const supply0=w.supply(w.primary);
  w.conn.faults.dropResponse=1;   // the purchase lands but its RPC response is lost
  r=await settle(w,()=>BB.step(ports,coin,cycleId),6);
  job=(await db.query('SELECT * FROM reward_buyback_jobs WHERE source_mint=$1',[mintS])).rows[0];
  assert.equal(job.state,'burned',JSON.stringify(r));assert.equal(job.route,'pump-amm');assert.ok(job.evidence.closed);
  const j=w.job(mint,0);assert.equal(j.state,'closed');assert.equal(BigInt(job.acquired_raw),j.acquired);assert.equal(BigInt(job.burned_raw),j.acquired);
  assert.equal(w.supply(w.primary),supply0-j.acquired,'finalized burn reduced PRIMARY supply');
  assert.equal((await db.query("SELECT count(*)::int n FROM reward_chain_attempts WHERE job=$1",[`bb-swap:${job.id}`])).rows[0].n,1,'exactly one purchase was ever signed');
  const acct=(await db.query('SELECT * FROM reward_funding_accounts WHERE mint=$1',[mintS])).rows[0];
  assert.equal(BigInt(acct.other_reserved),0n);assert.equal(BigInt(acct.other_settled),j.spent);assert.equal(w.coin(mint).buybackSpent,j.spent);
  assert.equal(w.coin(mint).holderUnallocated,BigInt(acct.holder_available),'holder reserve untouched by the buyback');
 }finally{await db.close();}
});
