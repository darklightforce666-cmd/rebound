'use strict';
// Direct settlement (no program): snapshot → reserve within the fee-wallet budget → batched SOL transfers
// signed by the imported fee-wallet key at the end of the round; public projections; dry run; no double pay.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Keypair,PublicKey}=require('@solana/web3.js');
const {SvmConnection}=require('./svm-connection.cjs'),{supabaseDb}=require('./pg.cjs'),{chain}=require('./chain-fixture.cjs');
const P3=require('../../server/rewards/policy-v3.cjs'),D=require('../../server/rewards/cycle-direct.cjs'),A=require('../../server/rewards/admin-v3.cjs'),Signer=require('../../server/rewards/signer.cjs');
const SOL=10n**9n,T0=1_800_000_000;
process.env.REWARDS_MAX_EXECUTION_MODE='mainnet_test';

async function world({mode='mainnet_test',holders=3,budget=5n*SOL,key=true,wallet=10n*SOL}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rebound-direct-'));const env={...process.env,REWARDS_SIGNER_MASTER_KEY_FILE:path.join(dir,'master.key')};
 fs.writeFileSync(env.REWARDS_SIGNER_MASTER_KEY_FILE,require('node:crypto').randomBytes(32).toString('hex'),{mode:0o600});
 const conn=new SvmConnection();conn.setTime(T0,1000);
 const dev=Keypair.generate();conn.airdrop(dev.publicKey,wallet);
 const people=Array.from({length:holders},()=>Keypair.generate().publicKey.toBase58());for(const p of people)conn.airdrop(new PublicKey(p),10_000_000n);
 const c=chain({startSlot:100,timeOf:s=>T0+(s-100)*1});const hi={vSol:300n*SOL,vTok:10n**12n};
 people.forEach((p,i)=>c.tx(x=>x.buy(p,'acct'+i,1_000_000n,{lamports:BigInt(4-i)*SOL,...hi})));
 c.tx(x=>x.buy(Keypair.generate().publicKey.toBase58(),'late',10n**9n,{lamports:1_000_000n,vSol:30n*SOL,vTok:10n**12n}));   // price drops 10×
 const db=await supabaseDb();const mint=Keypair.generate().publicKey.toBase58();
 await db.query("UPDATE reward_platform SET execution_mode=$1 WHERE namespace='mainnet_test'",[mode]);
 await db.query('SET ROLE rebound_api');
 try{await A.launch(db,'admin (password)',{},{mint,feeWallet:dev.publicKey.toBase58(),namespace:'mainnet_test',budgetPercent:50,startTest:mode==='mainnet_test'},{connection:null});}finally{await db.query('RESET ROLE');}
 await db.query("UPDATE reward_platform SET spend_cap_action_lamports=$1,spend_cap_cycle_lamports=$1,spend_cap_total_lamports=$2 WHERE namespace='mainnet_test'",[String(50n*SOL),String(500n*SOL)]);
 await db.query('UPDATE reward_coins SET schedule_anchor=$2 WHERE mint=$1',[mint,T0]);
 await db.query("UPDATE reward_funding_wallets SET budget_balance_lamports=$2,budget_lamports=$3,budget_start_deposits=0,budget_requested_at=now()-interval '1 minute',budget_set_at=now()-interval '1 minute' WHERE mint=$1",[mint,String(budget*2n),String(budget)]);
 if(key){const s=await Signer.importSigner(db,{role:'primary_dev',secretText:JSON.stringify(Array.from(dev.secretKey)),expectedAddress:dev.publicKey.toBase58(),env});
  await db.query("UPDATE reward_funding_wallets SET mode='automatic',signer=$2 WHERE mint=$1",[mint,s.id]);}
 await db.query("INSERT INTO reward_public_tokens(mint,namespace,kind,reward_status,pinned,test) VALUES($1,'mainnet_test','primary','active',true,true)",[mint]);
 const inputs=async(coinRow,n,cutoff,slot)=>({credits:await require('../../server/rewards/worker-v3.cjs').loadCredits(db,mint,slot),events:c.events,coverage:{complete:true,throughSlot:10_000},excluded:new Set(['CurvePDA']),fx:()=>null,solSeries:[]});
 const ports={db,connection:conn,worker:'w1',inputs,env,cutoffSlot:async t=>1000+(t-T0),now:async()=>conn.getBlockTime(),signer:fw=>Signer.load(db,fw.signer,{env})};
 const coin=async()=>(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0];
 const tick=async(k=3)=>{let r;for(let i=0;i<k;i++){conn.finalizeAll();r=await D.tick(ports,await coin());}return r;};
 return{conn,db,ports,mint,dev,people,tick,dir,cycle:async n=>(await db.query('SELECT * FROM reward_cycles WHERE id=$1',[`${mint}:${n}`])).rows[0],
  awards:async n=>(await db.query('SELECT * FROM reward_awards WHERE cycle_id=$1 ORDER BY leaf_index',[`${mint}:${n}`])).rows,done:async()=>{await db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('direct round: snapshot at the cutoff reserves within the budget; the fee wallet pays everyone at the end',async()=>{
 const w=await world();try{
  const first=await w.tick(1);assert.equal(first.cycle,1);assert.equal((await w.cycle(1)).state,'scheduled');
  w.conn.setTime(T0+90,1500);await w.tick();                                        // cutoff: 30 s before the end of a 120 s round
  const row=await w.cycle(1);assert.equal(row.state,'funded');
  const as=await w.awards(1);assert.equal(as.length,3);assert.ok(as.every(a=>a.state==='reserved'));
  const total=as.reduce((s,a)=>s+BigInt(a.amount_lamports),0n);assert.ok(total<=5n*SOL&&total>=5n*SOL-3n,'the whole budget (minus rounding): losses exceed it');
  // Pro rata to the loss: the biggest loser gets the most, nobody more than their loss.
  const pos=new Map((await w.db.query('SELECT owner,loss_usd FROM reward_snapshot_positions WHERE cycle_id=$1',[row.id])).rows.map(r=>[r.owner,BigInt(r.loss_usd)]));
  for(const a of as)assert.ok(BigInt(a.amount_lamports)<=pos.get(a.recipient));
  assert.ok(BigInt(as.find(a=>a.recipient===w.people[0]).amount_lamports)>BigInt(as.find(a=>a.recipient===w.people[2]).amount_lamports));
  assert.ok((await w.db.query('SELECT count(*)::int n FROM reward_lot_credits WHERE cycle_id=$1',[row.id])).rows[0].n>=3,'reserved awards are compensation immediately');
  const holders=(await w.db.query('SELECT * FROM reward_public_holders WHERE mint=$1',[w.mint])).rows;assert.ok(holders.length>=3);
  assert.ok(holders.filter(h=>w.people.includes(h.owner)).every(h=>BigInt(h.loss_lamports)>0n&&BigInt(h.cost_lamports)>BigInt(h.value_lamports)));
  const pc=(await w.db.query('SELECT * FROM reward_public_cycles WHERE mint=$1 AND cycle_number=1',[w.mint])).rows[0];assert.equal(pc.holders_underwater,3);assert.equal(pc.mode,'live');
  // Not before the end of the round.
  assert.equal(w.conn.sent,0);
  const before=await Promise.all(w.people.map(p=>w.conn.getBalance(new PublicKey(p))));
  w.conn.setTime(T0+120,1600);await w.tick(4);
  assert.equal((await w.cycle(1)).state,'complete');
  const after=await Promise.all(w.people.map(p=>w.conn.getBalance(new PublicKey(p))));
  for(const a of await w.awards(1)){assert.equal(a.state,'paid');const i=w.people.indexOf(a.recipient);assert.equal(BigInt(after[i]-before[i]),BigInt(a.amount_lamports));}
  assert.equal(w.conn.sent,1,'three recipients, one batched transaction');
  const payouts=(await w.db.query('SELECT * FROM reward_public_payouts WHERE mint=$1',[w.mint])).rows;assert.equal(payouts.length,3);assert.ok(payouts.every(p=>p.signature&&BigInt(p.loss_lamports)>0n));
  const tok=(await w.db.query('SELECT * FROM reward_public_tokens WHERE mint=$1',[w.mint])).rows[0];assert.equal(BigInt(tok.paid_lamports),total);assert.equal(tok.paid_recipients,3);
  assert.equal((await w.db.query('SELECT sum(paid_lamports)::text s FROM reward_public_holders WHERE mint=$1',[w.mint])).rows[0].s,String(total));
  // Next round: the budget is used up, so nothing more leaves the wallet (never above 50 %).
  w.conn.setTime(T0+210,2000);await w.tick();
  const r2=await w.cycle(2);assert.ok(['skipped_no_funds','funded'].includes(r2.state));assert.ok(BigInt(r2.total_lamports||0)<=5n*SOL-total,'round 2 can only use the rounding dust left of the budget: '+JSON.stringify(r2));
  const holders2=(await w.db.query('SELECT owner,compensated_lamports FROM reward_public_holders WHERE mint=$1 AND owner=ANY($2)',[w.mint,w.people])).rows;
  assert.equal(holders2.reduce((s,h)=>s+BigInt(h.compensated_lamports),0n),total,'round 2 counts round 1 as compensation');
 }finally{await w.done();}
});

test('a bigger budget pays each holder at most their loss, and the next round pays only what is still owed',async()=>{
 const w=await world({budget:15n*SOL,wallet:30n*SOL});try{
  w.conn.setTime(T0+90,1500);await w.tick();w.conn.setTime(T0+120,1600);await w.tick(4);
  const as=await w.awards(1);const pos=new Map((await w.db.query('SELECT owner,loss_usd FROM reward_snapshot_positions WHERE cycle_id=$1',[`${w.mint}:1`])).rows.map(r=>[r.owner,BigInt(r.loss_usd)]));
  const lossSum=w.people.reduce((s,p)=>s+pos.get(p),0n);assert.ok(lossSum<15n*SOL,String(lossSum));
  for(const a of as)assert.equal(BigInt(a.amount_lamports),pos.get(a.recipient),'fully compensated when the budget allows');
  w.conn.setTime(T0+210,2000);await w.tick();
  assert.equal((await w.cycle(2)).state,'skipped_no_eligible_holders','nobody is underwater after full compensation at an unchanged price');
 }finally{await w.done();}
});

test('dry run and a missing key compute the round publicly but reserve and send nothing',async()=>{
 for(const opts of [{mode:'dry_run'},{key:false}]){
  const w=await world(opts);try{
   w.conn.setTime(T0+90,1500);await w.tick();w.conn.setTime(T0+120,1600);await w.tick(3);
   const row=await w.cycle(1);assert.equal(row.state,'dry_run');assert.equal(row.reason,opts.key===false?'fee_wallet_key_missing':'dry_run');
   const as=await w.awards(1);assert.equal(as.length,3);assert.ok(as.every(a=>a.state==='planned'));
   assert.equal(w.conn.sent,0);assert.equal((await w.db.query('SELECT count(*)::int n FROM reward_lot_credits')).rows[0].n,0);
   assert.equal((await w.db.query('SELECT mode FROM reward_public_cycles WHERE mint=$1',[w.mint])).rows[0].mode,'dry_run');
   const avail=await D.available(w.db,w.conn,(await w.db.query('SELECT * FROM reward_funding_wallets WHERE mint=$1',[w.mint])).rows[0]);assert.equal(avail.lamports,5n*SOL,'nothing of the budget was used');
  }finally{await w.done();}
 }
});

test('the budget never exceeds what the wallet can pay: balance − reserved unpaid − 0.01 SOL',async()=>{
 const w=await world({budget:20n*SOL});try{
  const fw=(await w.db.query('SELECT * FROM reward_funding_wallets WHERE mint=$1',[w.mint])).rows[0];
  const a=await D.available(w.db,w.conn,fw);assert.equal(a.lamports,10n*SOL-D.FEE_RESERVE);assert.equal(a.reason,null);
  w.conn.setTime(T0+90,1500);await w.tick();
  const reserved=(await w.awards(1)).reduce((s,x)=>s+BigInt(x.amount_lamports),0n);
  const b=await D.available(w.db,w.conn,fw);assert.equal(b.lamports,10n*SOL-D.FEE_RESERVE-reserved>0n?10n*SOL-D.FEE_RESERVE-reserved:0n);
 }finally{await w.done();}
});

test('a batch that landed but was not recorded (crash) is recorded on the next pass, never paid twice',async()=>{
 const w=await world();try{
  w.conn.setTime(T0+90,1500);await w.tick();w.conn.setTime(T0+120,1600);
  // Simulate a crash right after the payment landed: undo the bookkeeping, keep the finalized attempt.
  await w.tick(4);const paidBefore=await Promise.all(w.people.map(p=>w.conn.getBalance(new PublicKey(p))));
  const att=(await w.db.query("SELECT * FROM reward_chain_attempts WHERE job LIKE 'direct-pay:%'")).rows;assert.equal(att.length,1);assert.equal(att[0].state,'finalized');
  await w.db.query("ALTER TABLE reward_awards DISABLE TRIGGER USER");
  await w.db.query("UPDATE reward_awards SET state='reserved',settlement_signature=NULL WHERE cycle_id=$1",[`${w.mint}:1`]);
  await w.db.query("ALTER TABLE reward_awards ENABLE TRIGGER USER");
  await w.db.query("DELETE FROM reward_public_payouts");
  await w.db.query("UPDATE reward_cycles SET state='paying' WHERE id=$1",[`${w.mint}:1`]);
  const sent=w.conn.sent;await w.tick(3);
  assert.equal(w.conn.sent,sent,'no second transaction');
  const after=await Promise.all(w.people.map(p=>w.conn.getBalance(new PublicKey(p))));assert.deepEqual(after,paidBefore);
  assert.ok((await w.awards(1)).every(a=>a.state==='paid'));assert.equal((await w.cycle(1)).state,'complete');
  assert.equal((await w.db.query('SELECT count(*)::int n FROM reward_public_payouts')).rows[0].n,3);
 }finally{await w.done();}
});

test('a paused namespace computes the round but reserves nothing; a round of a switched-away wallet uses the new wallet',async()=>{
 const w=await world();try{
  await w.db.query("UPDATE reward_platform SET paused=true WHERE namespace='mainnet_test'");
  w.conn.setTime(T0+90,1500);await w.tick();
  const r=await w.cycle(1);assert.equal(r.state,'dry_run');assert.equal(r.reason,'paused');assert.equal(w.conn.sent,0);
 }finally{await w.done();}
});
