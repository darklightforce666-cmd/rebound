'use strict';
// Public home and wallet-check reads: one query set for the home page (coins, headline round, latest
// settled rounds) and one for a wallet's positions. Both run as the API role on published tables only.
const test=require('node:test'),assert=require('node:assert/strict');
const {supabaseDb,as}=require('./pg.cjs');
const F=require('../../netlify/functions/rewards.cjs'),H=F._internal.handlers.GET;
const A='So11111111111111111111111111111111111111112',B='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',OWNER='4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';

test('home: coins with holders and current round, the headline round and the latest settled rounds',async()=>{
 const db=await supabaseDb();const now=Math.floor(Date.now()/1000);
 await db.query("UPDATE reward_site SET primary_mint=$1 WHERE id=1",[A]);
 await db.query("INSERT INTO reward_public_tokens(mint,namespace,kind,name,symbol,reward_status,paid_lamports,paid_recipients,payouts,burned_raw,decimals) VALUES($1,'mainnet_test','primary','Rebound','REBOUND','active',3000000000,4,5,0,6),($2,'production','third_party','Frog','FROG','active',0,0,0,125000000,6)",[A,B]);
 await db.query("INSERT INTO reward_public_holders(mint,owner,loss_lamports,cost_lamports,outcome,cycle_number) VALUES($1,$2,500,1000,'eligible',2),($1,'x2',0,10,'no_remaining_loss',2),($1,'x3',9,10,'sold',2)",[A,OWNER]);
 await db.query("INSERT INTO reward_public_cycles(mint,cycle_number,state,cutoff_time,scheduled_end,available_lamports,paid_lamports,paid_recipients) VALUES($1,1,'complete',$2,$3,1000,900,2),($1,2,'scheduled',$4,$5,NULL,0,0),($6,1,'skipped_no_eligible_holders',$2,$3,70,0,0)",[A,now-1860,now-1800,now+1740,now+1800,B]);
 await db.query("INSERT INTO reward_public_payouts(mint,cycle_number,owner,amount_lamports,loss_lamports,signature) VALUES($1,1,$2,600,700,'sigA'),($1,1,'x2',300,400,'sigA')",[A,OWNER]);
 const r=await as(db,'rebound_api',null,d=>H.home({db:d}));
 assert.equal(r.coins.length,2);assert.equal(r.coins[0].mint,A,'the REBOUND token first');assert.equal(r.coins[0].featured,true);
 assert.equal(r.coins[0].holders,2,'sold holders are not counted');assert.equal(r.coins[0].underwater,1);
 assert.equal(Number(r.coins[0].round.cycle_number),2);assert.equal(r.headline.mint,A);assert.equal(r.headline.cycles.length,2);
 assert.deepEqual(r.rounds.map(x=>[x.mint,Number(x.cycle_number),x.txs]).sort(),[[A,1,1],[B,1,0]].sort(),'settled rounds, one tx for one signature');
 const w=await as(db,'rebound_api',null,d=>H['wallet-check']({db:d,q:{wallet:OWNER}}));
 assert.equal(w.positions.length,1);assert.equal(w.positions[0].share_bps,10000,'the only loss that counts');assert.equal(w.positions[0].estimate_lamports,null,'no budget before the snapshot');
 assert.equal(w.paid.lamports,'600');
 await assert.rejects(()=>H['wallet-check']({db,q:{wallet:'nope'}}),/Solana address/);
});

test('portfolio and admin: wallet-check carries holdings for the portfolio; a token check is read-only and always logged',async()=>{
 const db=await supabaseDb();
 try{
  await db.query("INSERT INTO reward_public_tokens(mint,namespace,kind,name,symbol,reward_status,decimals) VALUES($1,'production','third_party','Frog','FROG','active',6)",[B]);
  await db.query("INSERT INTO reward_public_holders(mint,owner,quantity_raw,cost_lamports,value_lamports,loss_lamports,paid_lamports,payouts,outcome,cycle_number) VALUES($1,$2,5000000,1000,400,500,100,1,'eligible',2)",[B,OWNER]);
  const w=await as(db,'rebound_api',null,d=>H['wallet-check']({db:d,q:{wallet:OWNER}}));
  const p=w.positions[0];assert.equal(p.quantity_raw,'5000000');assert.equal(p.decimals,6);assert.equal(p.cost_lamports,'1000');assert.equal(p.paid_lamports,'100');
  // Admin check of a contract address: no mint there → a problem, and a log row either way.
  const A=require('../../server/rewards/admin-v3.cjs');
  const conn={getParsedAccountInfo:async()=>({value:null}),getMultipleAccountsInfo:async()=>[null,null]};
  const r=await A.checkToken(db,conn,'admin (password)',A_MINT);   // (outside a rolled-back role transaction, so the log row stays)
  assert.equal(r.exists,false);assert.equal(r.ok,false);assert.match(r.problems[0],/No token mint/);
  const logs=(await db.query("SELECT safe_message,severity,mint FROM reward_logs WHERE event_type='token_checked'")).rows;
  assert.equal(logs.length,1);assert.equal(logs[0].mint,A_MINT);assert.equal(logs[0].severity,'warn');
  // The API role (which serves the dashboard) may write the check's log row.
  await as(db,'rebound_api',null,async d=>{await A.checkToken(d,conn,'x',A_MINT);assert.equal((await d.query("SELECT count(*)::int n FROM reward_logs WHERE event_type='token_checked'")).rows[0].n,2);});
  await assert.rejects(()=>A.checkToken(db,conn,'admin','not-a-mint'),/Invalid token contract/);
 }finally{await db.close();}
});
const A_MINT='3SohGcVPEwv6HS4DcSCMBE6RKu623aVzZKh4oWFppump';

test('public round numbers start at the first round that ran (no-funds rounds before it are hidden)',async()=>{
 const db=await supabaseDb();
 try{
  await db.query("INSERT INTO reward_public_cycles(mint,cycle_number,state,cutoff_time,scheduled_end,paid_lamports,paid_recipients) VALUES($1,1,'skipped_no_funds',1,2,0,0),($1,2,'complete',3,4,900,2),($1,3,'scheduled',5,6,0,0),($2,1,'complete',1,2,5,1)",[A,B]);
  const out={cycles:[{mint:A,cycle_number:3,state:'scheduled'},{mint:A,cycle_number:2,state:'complete'},{mint:A,cycle_number:1,state:'skipped_no_funds'}],coin:{mint:A,round:{cycle_number:'3',state:'scheduled'}},other:[{mint:B,cycle_number:1,state:'complete'}],payouts:[{mint:A,cycle_number:2,owner:'x'}]};
  await F._internal.publicRounds(db,out);
  assert.deepEqual(out.cycles.map(c=>c.cycle_number),[2,1]);assert.equal(out.coin.round.cycle_number,2);assert.equal(out.other[0].cycle_number,1);assert.equal(out.payouts[0].cycle_number,1);
 }finally{await db.close();}
});
