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
