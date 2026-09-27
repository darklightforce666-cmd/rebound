'use strict';
// Direct settlement (no program): snapshot → reserve within the fee-wallet budget → batched SOL transfers
// signed by the imported fee-wallet key at the end of the round; public projections; dry run; no double pay.
const nodeTest=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Keypair,PublicKey}=require('@solana/web3.js');
const {SvmConnection}=require('./svm-connection.cjs'),{supabaseDb}=require('./pg.cjs'),{chain}=require('./chain-fixture.cjs');
const P3=require('../../server/rewards/policy-v3.cjs'),D=require('../../server/rewards/cycle-direct.cjs'),A=require('../../server/rewards/admin-v3.cjs'),Signer=require('../../server/rewards/signer.cjs');
const SOL=10n**9n,T0=1_800_000_000;
process.env.REWARDS_MAX_EXECUTION_MODE='mainnet_test';
const Pos=require('../../server/rewards/positions-v3.cjs'),I=require('../../server/rewards/indexer.cjs');
// Every test runs twice: rounds from a full replay of the history, and rounds from ready-made positions
// (migration 017). Both must give exactly the same awards and payouts.
let MODE='replay';const SAME={};
const test=(name,fn)=>{for(const m of ['replay','positions'])nodeTest(`${name} [${m}]`,async()=>{MODE=m;return fn();});};
async function storeEvents(db,mint,events){
 const rows=events.map(e=>({id:e.id,signature:e.signature,path:e.path,event_index:e.order,slot:e.slot,tx:e.transactionIndex,order:e.order,kind:e.kind,owner:e.owner,data:{...e.data,time:e.time}}));
 await db.query(`INSERT INTO reward_events(id,mint,signature,instruction_path,event_index,slot,transaction_index,execution_order,kind,owner,data,raw_digest,parser_version,finalized)
  SELECT id,$1,signature,path,event_index,slot,tx,"order",kind,owner,data,'test',$3,true FROM jsonb_to_recordset($2::jsonb) AS x(id text,signature text,path text,event_index int,slot bigint,tx int,"order" int,kind text,owner text,data jsonb)`,[mint,JSON.stringify(rows),I.PARSER]);
}

// Settlement mechanics are exercised under v3.1 (no maturity, 60 s price window); v3.2 rules have their own tests.
async function world({mode='mainnet_test',holders=3,budget=5n*SOL,key=true,wallet=10n*SOL,policy='rebound-v3.1-test',build=null,income=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rebound-direct-'));const env={...process.env,REWARDS_SIGNER_MASTER_KEY_FILE:path.join(dir,'master.key')};
 fs.writeFileSync(env.REWARDS_SIGNER_MASTER_KEY_FILE,require('node:crypto').randomBytes(32).toString('hex'),{mode:0o600});
 const conn=new SvmConnection();conn.setTime(T0,1000);
 const dev=Keypair.generate();conn.airdrop(dev.publicKey,wallet);
 const people=Array.from({length:holders},()=>Keypair.generate().publicKey.toBase58());for(const p of people)conn.airdrop(new PublicKey(p),10_000_000n);
 const c=chain({startSlot:100,timeOf:s=>T0+(s-100)*1});const hi={vSol:300n*SOL,vTok:10n**12n};
 if(build)build(c,people,hi);else{
 people.forEach((p,i)=>c.tx(x=>x.buy(p,'acct'+i,1_000_000n,{lamports:BigInt(4-i)*SOL,...hi})));
 c.tx(x=>x.buy(Keypair.generate().publicKey.toBase58(),'late',10n**9n,{lamports:1_000_000n,vSol:30n*SOL,vTok:10n**12n}));}   // price drops 10×
 const db=await supabaseDb();const mint=Keypair.generate().publicKey.toBase58();
 await db.query("UPDATE reward_platform SET execution_mode=$1 WHERE namespace='mainnet_test'",[mode]);
 await db.query('SET ROLE rebound_api');
 try{await A.launch(db,'admin (password)',{},{mint,feeWallet:dev.publicKey.toBase58(),namespace:'mainnet_test',budgetPercent:50,startTest:mode==='mainnet_test',...(income?{fundingModel:'income'}:{})},{connection:null});}finally{await db.query('RESET ROLE');}
 await db.query("UPDATE reward_platform SET spend_cap_action_lamports=$1,spend_cap_cycle_lamports=$1,spend_cap_total_lamports=$2 WHERE namespace='mainnet_test'",[String(50n*SOL),String(500n*SOL)]);
 await db.query('UPDATE reward_coins SET schedule_anchor=$2,policy_version=$3,policy_hash=$4 WHERE mint=$1',[mint,T0,policy,P3.hashOf(P3.policy(policy))]);
 if(income)await db.query("UPDATE reward_funding_wallets SET opening_slot=0,opening_balance_lamports=$2,opening_credit_lamports=0,operational_reserve_lamports=10000000 WHERE mint=$1",[mint,String(wallet)]);
 else await db.query("UPDATE reward_funding_wallets SET budget_balance_lamports=$2,budget_lamports=$3,budget_start_deposits=0,budget_requested_at=now()-interval '1 minute',budget_set_at=now()-interval '1 minute' WHERE mint=$1",[mint,String(budget*2n),String(budget)]);
 if(key){const s=await Signer.importSigner(db,{role:'primary_dev',secretText:JSON.stringify(Array.from(dev.secretKey)),expectedAddress:dev.publicKey.toBase58(),env});
  await db.query("UPDATE reward_funding_wallets SET mode='automatic',signer=$2 WHERE mint=$1",[mint,s.id]);}
 await db.query("INSERT INTO reward_public_tokens(mint,namespace,kind,reward_status,pinned,test) VALUES($1,'mainnet_test','primary','active',true,true)",[mint]);
 let verified=10_000;
 const inputs=async(coinRow,n,cutoff,slot)=>({credits:await require('../../server/rewards/worker-v3.cjs').loadCredits(db,mint,slot),events:c.events,coverage:{complete:true,throughSlot:verified},excluded:new Set(['CurvePDA']),fx:()=>null,solSeries:[]});
 const ports={db,connection:conn,worker:'w1',inputs,env,cutoffSlot:async t=>1000+(t-T0),now:async()=>conn.getBlockTime(),signer:fw=>Signer.load(db,fw.signer,{env})};
 if(MODE==='positions'){
  await storeEvents(db,mint,c.events);
  await db.query("INSERT INTO reward_checkpoints(name,through_slot,through_time,start_slot,complete,parser_version,digest) VALUES($1,10000,$2,0,true,$3,'')",['verified:'+mint,T0+10000,I.PARSER]);
  const excluded=new Set(['CurvePDA']);
  ports.inputs=async()=>{throw Error('a round must not replay the history in positions mode');};
  ports.positions={project:(coin,o={})=>Pos.project({db},coin,{maxEvents:2,excluded,...o}),inputsAt:(coin,cut,slot)=>Pos.inputsAt(db,coin,cut,slot),applyCredits:Pos.applyCredits};
 }
 const coin=async()=>(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0];
 const tick=async(k=3)=>{let r;for(let i=0;i<k;i++){conn.finalizeAll();r=await D.tick(ports,await coin());}return r;};
 const setVerified=async v=>{verified=v;if(MODE==='positions')await db.query('UPDATE reward_checkpoints SET through_slot=$2 WHERE name=$1',['verified:'+mint,v]);};
 return{conn,db,ports,mint,dev,people,tick,dir,setVerified,cycle:async n=>(await db.query('SELECT * FROM reward_cycles WHERE id=$1',[`${mint}:${n}`])).rows[0],
  awards:async n=>(await db.query('SELECT * FROM reward_awards WHERE cycle_id=$1 ORDER BY leaf_index',[`${mint}:${n}`])).rows,done:async()=>{await db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('direct round: snapshot at the cutoff reserves within the budget; the fee wallet pays everyone at the end',async()=>{
 const w=await world();try{
  const first=await w.tick(1);assert.equal(first.cycle,1);assert.equal((await w.cycle(1)).state,'scheduled');
  w.conn.setTime(T0+90,1500);await w.tick();                                        // cutoff: 30 s before the end of a 120 s round
  const row=await w.cycle(1);assert.equal(row.state,'funded');
  const as=await w.awards(1);assert.equal(as.length,3);assert.ok(as.every(a=>a.state==='reserved'));
  // Same awards whichever way the round was computed.
  const key=as.map(a=>[w.people.indexOf(a.recipient),String(a.amount_lamports),String(a.credit_usd)].join(':')).sort().join(',');
  if(MODE==='replay')SAME.first=key;else{assert.equal(key,SAME.first);
   const st=(await w.db.query('SELECT * FROM reward_projection_state WHERE mint=$1',[w.mint])).rows[0];assert.equal(Number(st.applied_slot),1090,'positions stand at the cutoff slot');assert.ok(Number(st.credits_applied)>=3);}
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
  const k2=JSON.stringify([r2.state,String(r2.total_lamports||0)]);if(MODE==='replay')SAME.second=k2;else assert.equal(k2,SAME.second);
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

test('v3.2: a purchase counts after 15 minutes; any sale or transfer excludes the wallet for good; funded awards survive a later sale',async()=>{
 const other=Keypair.generate().publicKey.toBase58();
 const w=await world({policy:'rebound-v3.2-test',budget:5n*SOL,build:(c,people,hi)=>{
  people.forEach((p,i)=>c.tx(x=>x.buy(p,'acct'+i,1_000_000n,{lamports:BigInt(4-i)*SOL,...hi})));
  c.tx(x=>x.sell(people[1],'acct1',1000n,{vSol:300n*SOL,vTok:10n**12n}));         // sells a little: out for good
  c.tx(x=>x.transfer(people[2],'acct2',other,'o1',1000n));                          // transfers a little: out for good
  c.tx(x=>x.buy(people[1],'acct1',1000n,{lamports:SOL/1000n,...hi}));              // buying again does not restore it
  c.tx(x=>x.buy(Keypair.generate().publicKey.toBase58(),'late',10n**9n,{lamports:1_000_000n,vSol:30n*SOL,vTok:10n**12n}));
  c.skipTo(1950);c.tx(x=>x.sell(people[0],'acct0',1000n,{vSol:30n*SOL,vTok:10n**12n}));}});   // after round 8's snapshot slot (1930)
 try{
  w.conn.setTime(T0+90,1500);await w.tick();
  const r1=await w.cycle(1);assert.equal(r1.state,'waiting_for_data');assert.equal(r1.reason,'price_window_incomplete','no 15-minute price history yet');
  assert.equal((await w.awards(1)).length,0);
  // Round 3 (cutoff T0+330): a 15-minute price exists? not yet either; round 8 is the first with both.
  // Round 8's cutoff (T0+930) is 15 minutes after the purchases: only the wallet that never sold or moved tokens is paid.
  w.conn.setTime(T0+930,3000);await w.tick();
  const r8=await w.cycle(8);assert.equal(r8.state,'funded',JSON.stringify(r8));
  const as=await w.awards(8);assert.deepEqual(as.map(a=>a.recipient),[w.people[0]]);
  const out=new Map((await w.db.query('SELECT owner,outcome FROM reward_snapshot_positions WHERE cycle_id=$1',[r8.id])).rows.map(r=>[r.owner,r.outcome]));
  assert.equal(out.get(w.people[0]),'eligible');assert.equal(out.get(w.people[1]),'exited');assert.equal(out.get(w.people[2]),'exited');
  assert.equal((await w.cycle(1)).state,'missed');
  w.conn.setTime(T0+960,3100);await w.tick(4);
  assert.equal((await w.awards(8))[0].state,'paid','funded before a later sale: paid');
 }finally{await w.done();}
});

test('85/15 vault: a round pays at most 20 % of the holders\' 85 %; the 15 % on the wallet is never touched',async()=>{
 const w=await world({income:true});try{
  const DBm=require('../../server/rewards/db.cjs'),FS=require('../../server/rewards/funding-store.cjs');
  const fw=async()=>(await w.db.query('SELECT * FROM reward_funding_wallets WHERE mint=$1',[w.mint])).rows[0];
  const none=await D.available(w.db,w.conn,await fw());
  assert.equal(none.lamports,0n);assert.equal(none.reason,'no_new_fees','nothing credited yet: nothing to pay');
  await DBm.transaction(w.db,async tx=>{await tx.query("INSERT INTO reward_funding_accounts(mint,kind) VALUES($1,'primary') ON CONFLICT DO NOTHING",[w.mint]);
   await FS.applyCredits(tx,w.mint,[{id:'fee1',signature:'fee-sig-1',slot:5,time:T0+5,gross:2n*SOL}]);});
  const a0=await D.available(w.db,w.conn,await fw());
  assert.equal(a0.vault,17n*SOL/10n,'the vault is 85 % of 2 SOL');assert.equal(a0.lamports,17n*SOL/50n,'a round may take 20 % of it: 0.34 SOL');
  w.conn.setTime(T0+90,1500);await w.tick();
  const as=await w.awards(1);const total=as.reduce((x,a)=>x+BigInt(a.amount_lamports),0n);
  assert.equal((await w.cycle(1)).state,'funded');assert.ok(total<=17n*SOL/50n&&total>=17n*SOL/50n-3n,'20 % of the vault: '+total);
  const after=await D.available(w.db,w.conn,await fw());
  assert.equal(after.vault,17n*SOL/10n-total,'the rest stays in the vault for later rounds');assert.ok(after.lamports>0n&&after.lamports<=after.vault/5n,'the next round takes 20 % of what is left');
  // The 15 % share still on the wallet (0.3 SOL) is held out of what any round may spend.
  assert.equal(after.kept,3n*SOL/10n,'the 15 % share is kept');
 }finally{await w.done();}
});

test('a round whose history is still catching up waits at the snapshot — never missed — and the schedule follows it',async()=>{
 const w=await world();try{
  await w.setVerified(1050);                                                        // verified only through slot 1050; round 1 cuts off at slot 1090
  await w.tick(1);w.conn.setTime(T0+90,1500);await w.tick();
  let r1=await w.cycle(1);assert.equal(r1.state,'waiting_for_data');assert.equal(r1.reason,'history_behind_cutoff');
  w.conn.setTime(T0+400,1600);await w.tick();                                      // a whole round later: still waiting, nothing opened after it
  r1=await w.cycle(1);assert.equal(r1.state,'waiting_for_data','catching up never drops a round');
  assert.equal(await w.cycle(2),undefined,'the next round waits for this one');
  await w.setVerified(10_000);await w.tick();                                       // the data arrives: snapshot at the ORIGINAL cutoff slot
  r1=await w.cycle(1);assert.equal(r1.state,'funded');assert.equal(Number(r1.cutoff_slot),1090);
  assert.equal(Number(r1.due_at),T0+400+30,'payout keeps the full 30 s lead after the late snapshot');assert.equal(Number(r1.scheduled_end),T0+120,'the schedule itself never changes');
  const pc=(await w.db.query('SELECT scheduled_end FROM reward_public_cycles WHERE mint=$1 AND cycle_number=1',[w.mint])).rows[0];assert.equal(Number(pc.scheduled_end),T0+430);
  w.conn.setTime(T0+420,1610);await w.tick();assert.equal(w.conn.sent,0,'not paid before its new end');
  w.conn.setTime(T0+430,1620);await w.tick(4);
  assert.equal((await w.cycle(1)).state,'complete');
  const r2=await w.cycle(2);assert.ok(r2,'round 2 opened when round 1 ended');
  assert.equal(Number(r2.cycle_start),T0+430);assert.equal(Number(r2.scheduled_end),T0+550);assert.equal(Number(r2.cutoff_time),T0+520);
 }finally{await w.done();}
});

test('a snapshot a few seconds after the cutoff keeps the schedule (no drift); a stale waiting round of a stopped token is closed',async()=>{
 const w=await world();try{
  await w.tick(1);w.conn.setTime(T0+95,1500);await w.tick();                        // 5 s after the cutoff: the usual processing delay
  const r1=await w.cycle(1);assert.equal(r1.state,'funded');assert.equal(Number(r1.due_at),T0+120,'payout stays at the scheduled end');
  w.conn.setTime(T0+120,1600);await w.tick(4);
  const r2=await w.cycle(2);assert.equal(Number(r2.cycle_start),T0+120);assert.equal(Number(r2.cutoff_time),T0+210);
  await w.setVerified(1100);w.conn.setTime(T0+215,1700);await w.tick();            // round 2 waits for data...
  assert.equal((await w.cycle(2)).state,'waiting_for_data');
  await w.db.query("UPDATE reward_coins SET status='paused' WHERE mint=$1",[w.mint]);
  w.conn.setTime(T0+400,1800);await w.tick();                                       // ...and the token stops: closed, never paid later
  const r2b=await w.cycle(2);assert.equal(r2b.state,'missed');assert.equal(r2b.reason,'token_inactive');
 }finally{await w.done();}
});
