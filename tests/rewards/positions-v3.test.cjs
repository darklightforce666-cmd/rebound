'use strict';
// Ready-made holder positions (migration 017): applying verified events in small batches gives exactly the
// positions of one full replay; late events and changed awards rebuild them; the site's holder table is
// kept live and revalued on a new price without touching the history.
const test=require('node:test'),assert=require('node:assert/strict');
const {Keypair}=require('@solana/web3.js');
const {supabaseDb}=require('./pg.cjs'),{chain,SOL}=require('./chain-fixture.cjs');
const P3=require('../../server/rewards/policy-v3.cjs'),L=require('../../server/rewards/lots-v3.cjs'),Pos=require('../../server/rewards/positions-v3.cjs'),A=require('../../server/rewards/admin-v3.cjs'),I=require('../../server/rewards/indexer.cjs');
const T0=1_800_000_000,excluded=new Set(['CurvePDA']);
const solFx=t=>({time:Number(t),price:P3.LAMPORTS,conf:0n,source:'sol-unit'});

async function setup(){
 const db=await supabaseDb();const mint=Keypair.generate().publicKey.toBase58(),fee=Keypair.generate().publicKey.toBase58();
 await db.query('SET ROLE rebound_api');
 try{await A.launch(db,'admin (password)',{},{mint,feeWallet:fee,namespace:'mainnet_test',budgetPercent:50,startTest:true},{connection:null});}finally{await db.query('RESET ROLE');}
 await db.query("INSERT INTO reward_public_tokens(mint,namespace,kind,reward_status,pinned,test) VALUES($1,'mainnet_test','primary','active',true,true)",[mint]);
 await db.query('UPDATE reward_coins SET schedule_anchor=NULL WHERE mint=$1',[mint]);   // no rounds: nothing caps the projection
 const coin=async()=>(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0];
 const store=async events=>{const rows=events.map(e=>({id:e.id,signature:e.signature,path:e.path,event_index:e.order,slot:e.slot,tx:e.transactionIndex,order:e.order,kind:e.kind,owner:e.owner,data:{...e.data,time:e.time}}));
  await db.query(`INSERT INTO reward_events(id,mint,signature,instruction_path,event_index,slot,transaction_index,execution_order,kind,owner,data,raw_digest,parser_version,finalized)
   SELECT id,$1,signature,path,event_index,slot,tx,"order",kind,owner,data,'test',$3,true FROM jsonb_to_recordset($2::jsonb) AS x(id text,signature text,path text,event_index int,slot bigint,tx int,"order" int,kind text,owner text,data jsonb) ON CONFLICT DO NOTHING`,[mint,JSON.stringify(rows),I.PARSER]);};
 const verify=async(slot,time)=>db.query(`INSERT INTO reward_checkpoints(name,through_slot,through_time,start_slot,complete,parser_version,digest) VALUES($1,$2,$3,0,true,$4,'')
  ON CONFLICT(name) DO UPDATE SET through_slot=EXCLUDED.through_slot,through_time=EXCLUDED.through_time`,['verified:'+mint,slot,time,I.PARSER]);
 const project=async(o={})=>{let r,rebuilt=null;for(let i=0;i<200;i++){r=await Pos.project({db},await coin(),{maxEvents:3,excluded,...o});rebuilt=rebuilt||r.rebuilt;if(r.applied===0&&!r.rebuilt)break;}return{...r,rebuilt};};
 const stored=async()=>new Map((await db.query('SELECT * FROM reward_holder_positions WHERE mint=$1',[mint])).rows.map(r=>[r.owner,r]));
 return{db,mint,coin,store,verify,project,stored};
}
// A busy history: buys at falling prices, partial sales, wallet-to-wallet transfers, a burn, one wallet
// with two token accounts, and a transfer-only recipient.
function busy(){
 const c=chain({startSlot:100,timeOf:s=>T0+(s-100)});const W=[...Array(6)].map(()=>Keypair.generate().publicKey.toBase58());
 let v=300n*SOL;const px=()=>({vSol:(v=v*9n/10n),vTok:10n**12n});
 W.forEach((w,i)=>c.tx(x=>x.buy(w,'a'+i,1_000_000n*BigInt(i+1),{lamports:BigInt(i+1)*SOL/2n,...px()})));
 c.tx(x=>x.buy(W[0],'a0b',500_000n,{lamports:SOL/3n,...px()}));                    // second account of W0
 c.tx(x=>x.sell(W[1],'a1',700_000n,px()));
 c.tx(x=>x.transfer(W[2],'a2',W[5],'a5',1_000_000n));
 c.tx(x=>x.transfer(W[3],'a3','GIFT','g',400_000n));
 c.tx(x=>x.burn(W[4],'a4',250_000n));
 c.tx(x=>x.buy(W[1],'a1',2_000_000n,{lamports:SOL,...px()}));
 c.tx(x=>{x.sell(W[0],'a0',300_000n,px());x.sell(W[0],'a0b',100_000n,px());});
 c.tx(x=>x.sell(W[5],'a5',6_000_000n,px()));
 return{c,W};
}
function same(storedMap,full){
 for(const [owner,bk] of full.owners){
  const lots=bk.lots.filter(l=>l.remainingQuantity>0n),t=Pos.totals(lots,bk.holds),row=storedMap.get(owner);
  if(!row){assert.equal(lots.length+bk.holds.length,0,'missing position of '+owner);continue;}
  assert.deepEqual([row.recognized_raw,row.unrecognized_raw,row.cost_lamports,row.credit_lamports].map(String),[t.recognized,t.unrecognized,t.cost,t.credit].map(String),owner);
  assert.deepEqual(row.lots.map(l=>[l.id,l.remainingQuantity,l.remainingCost,String(BigInt(l.paidCredit)+BigInt(l.reservedCredit))]),lots.map(l=>[l.id,String(l.remainingQuantity),String(l.remainingCost),String(l.paidCredit+l.reservedCredit)]),owner);
  assert.deepEqual(new Set(row.holds.map(h=>h.reason)),new Set(bk.holds.map(h=>h.reason)));
  assert.deepEqual(row.exited||null,bk.exited||null,'exit of '+owner);
 }
}

test('small verified batches give exactly the positions of one full replay',async()=>{
 const s=await setup();try{
  const {c}=busy();await s.store(c.events);const last=c.events.at(-1).slot;
  await s.verify(last-3,T0+last-103);                        // not everything verified yet
  let r=await s.project();assert.equal(r.appliedSlot,last-3);
  same(await s.stored(),L.replay(c.events,{excluded,fx:solFx,throughSlot:last-3,exitOnOutflow:true}));
  await s.verify(last,T0+last-100);r=await s.project();assert.equal(r.appliedSlot,last);
  same(await s.stored(),L.replay(c.events,{excluded,fx:solFx,exitOnOutflow:true}));
  const st=(await s.db.query('SELECT * FROM reward_projection_state WHERE mint=$1',[s.mint])).rows[0];
  assert.equal(Number(st.events_applied),c.events.length);assert.equal(st.rebuilds,0);
  // The site's holder table follows the positions.
  const pub=(await s.db.query('SELECT * FROM reward_public_holders WHERE mint=$1',[s.mint])).rows;assert.ok(pub.length>=4);
  const tok=(await s.db.query('SELECT positions_slot FROM reward_public_tokens WHERE mint=$1',[s.mint])).rows[0];assert.equal(Number(tok.positions_slot),last);
 }finally{await s.db.close();}
});

test('a late event (found after the frontier passed it) rebuilds the positions from the stored history',async()=>{
 const s=await setup();try{
  const {c,W}=busy();
  // A transfer inside an already applied slot range, discovered later (e.g. by the holder scan).
  const lateSlot=c.events[Math.floor(c.events.length/2)].slot;
  await s.store(c.events);const last=c.events.at(-1).slot;await s.verify(last,T0+last-100);await s.project();
  const base={signature:'late-sig',slot:lateSlot,time:T0+lateSlot-100,transactionIndex:999,eventIndex:0,path:'0'};
  const extra=[{...base,id:'late:1',order:1,kind:'transfer_exit',owner:W[4],data:{source:'a4',destination:'late1',to:'LATE',amount:'10000'}},
   {...base,id:'late:2',order:2,kind:'incoming_transfer',owner:'LATE',data:{from:W[4],amount:'10000'}}];
  await s.store(extra);
  const r=await s.project();assert.equal(r.rebuilt,'late_event');
  same(await s.stored(),L.replay([...c.events,...extra],{excluded,fx:solFx,exitOnOutflow:true}));
  const st=(await s.db.query('SELECT * FROM reward_projection_state WHERE mint=$1',[s.mint])).rows[0];assert.equal(st.rebuilds,1);assert.equal(Number(st.events_applied),c.events.length+extra.length);
 }finally{await s.db.close();}
});

test('a new price revalues the live holder table in one statement; the history is not read',async()=>{
 const s=await setup();try{
  const {c}=busy();await s.store(c.events);const last=c.events.at(-1).slot;await s.verify(last,T0+last-100);await s.project();
  const loss=async()=>(await s.db.query('SELECT COALESCE(sum(loss_lamports),0)::text l FROM reward_public_holders WHERE mint=$1',[s.mint])).rows[0].l;
  const obs=(vSol,t)=>s.db.query("INSERT INTO reward_price_observations(mint,slot,observed_at,market,base_reserve,real_quote,virtual_quote,evidence,quote_model,block_time,heartbeat) VALUES($1,$2,$3,'curve',$4,0,$5,'{}','curve',$3,true)",[s.mint,t,t,String(10n**12n),String(vSol)]);
  await obs(300n*SOL,T0+1000);await s.db.query('UPDATE reward_projection_state SET revalued_at=NULL WHERE mint=$1',[s.mint]);await s.project();
  const high=BigInt(await loss());
  await obs(3n*SOL,T0+1001);await s.db.query('UPDATE reward_projection_state SET revalued_at=NULL WHERE mint=$1',[s.mint]);
  const before=(await s.db.query('SELECT events_applied FROM reward_projection_state WHERE mint=$1',[s.mint])).rows[0];
  await s.project();const low=BigInt(await loss());
  assert.ok(low>high,`a price crash raises the losses (${high} → ${low})`);
  assert.equal((await s.db.query('SELECT events_applied FROM reward_projection_state WHERE mint=$1',[s.mint])).rows[0].events_applied,before.events_applied);
  // Each holder: loss = cost − value − compensation at the new price.
  for(const h of (await s.db.query("SELECT * FROM reward_public_holders WHERE mint=$1 AND quantity_raw>0 AND outcome IN ('eligible','no_remaining_loss')",[s.mint])).rows){
   const v=(BigInt(h.quantity_raw)*(3n*SOL*P3.E18/10n**12n)+P3.E18-1n)/P3.E18,c=BigInt(h.cost_lamports),k=BigInt(h.compensated_lamports);
   assert.equal(BigInt(h.value_lamports),v);assert.equal(BigInt(h.loss_lamports),c>v+k?c-v-k:0n);}
 }finally{await s.db.close();}
});

test('a pass without a target stops at the last event before a waiting round’s cutoff, so the round never forces a rebuild',async()=>{
 const s=await setup();try{
  const c=chain({startSlot:100,timeOf:x=>T0+(x-100)});const W=[...Array(3)].map(()=>Keypair.generate().publicKey.toBase58());
  W.forEach((w,i)=>c.tx(x=>x.buy(w,'a'+i,1_000_000n*BigInt(i+1),{lamports:SOL})));
  const cutSlot=c.events.at(-1).slot+5;                                            // empty slots after the last trade
  c.skipTo(cutSlot+50);c.tx(x=>x.buy(W[0],'a0',1000n,{lamports:SOL}));               // next trade well after the cutoff
  await s.store(c.events);const last=c.events.at(-1).slot;await s.verify(last+10,T0+last+10-100);
  const coin=await s.coin(),cutoff=T0+(cutSlot-100);
  await s.db.query(`INSERT INTO reward_cycles(id,mint,cycle_number,namespace,policy_version,config_version,anchor,cycle_start,scheduled_end,cutoff_time,state,due_at) VALUES($1,$2,1,$3,$4,0,$5,$5,$6,$7,'scheduled',$6)`,[s.mint+':1',s.mint,coin.namespace,coin.policy_version,cutoff-100,cutoff+30,cutoff]);
  const r1=await Pos.project({db:s.db},coin,{excluded});assert.ok(r1.appliedSlot<=cutSlot,`stopped at ${r1.appliedSlot}, cutoff slot ${cutSlot}`);
  const r2=await Pos.project({db:s.db},coin,{excluded,target:cutSlot});assert.equal(r2.ready,true);assert.equal(r2.rebuilt,null);
  assert.equal((await s.db.query('SELECT rebuilds FROM reward_projection_state WHERE mint=$1',[s.mint])).rows[0].rebuilds,0);
 }finally{await s.db.close();}
});

test('a credit on a lot that a late outflow closed is absorbed (as in a full replay), not a token-wide hold',async()=>{
 const s=await setup();try{
  const c=chain({startSlot:100,timeOf:x=>T0+(x-100)});
  c.tx(x=>x.buy('A','a',1000n,{lamports:SOL}));c.tx(x=>x.transfer('A','a','B','b',1000n));c.skipTo(200);c.tx(x=>x.buy('C','c',5n,{lamports:SOL}));
  const lotId=c.events.find(e=>e.kind==='purchase_candidate').id,coin=await s.coin();
  await s.store(c.events);await s.verify(210,T0+110);
  // A round at slot 150 credited A's lot (before the transfer at 102 was known — now it is).
  await s.db.query(`INSERT INTO reward_cycles(id,mint,cycle_number,namespace,policy_version,config_version,anchor,cycle_start,scheduled_end,cutoff_time,state,due_at,cutoff_slot,snapshot_hash) VALUES($1,$2,1,$3,$4,0,$5,$5,$6,$7,'complete',$6,150,'h')`,[s.mint+':1',s.mint,coin.namespace,coin.policy_version,T0,T0+60,T0+50]);
  await s.db.query(`INSERT INTO reward_awards(cycle_id,leaf_index,mint,recipient,amount_lamports,credit_usd,lot_credits,proof,state,reserved_at) VALUES($1,0,$2,'A',10,10,'[]','[]','reserved',now())`,[s.mint+':1',s.mint]);
  await s.db.query(`INSERT INTO reward_lot_credits(cycle_id,leaf_index,lot_id,credit_usd) VALUES($1,0,$2,10)`,[s.mint+':1',lotId]);
  const r=await s.project();assert.equal(r.appliedSlot,210);
  const st=(await s.db.query('SELECT * FROM reward_projection_state WHERE mint=$1',[s.mint])).rows[0];
  assert.deepEqual(st.mint_holds,[]);assert.equal(Number(st.credits_applied),1);
  same(await s.stored(),L.replay(c.events,{excluded,fx:solFx,credits:[{slot:150,lotId,credit:10n,state:'reserved',award:'x'}],exitOnOutflow:true}));
 }finally{await s.db.close();}
});

test('a parser hold on a transaction that produced no event still holds the wallet at the round',async()=>{
 const s=await setup();try{
  const {c,W}=busy();await s.store(c.events);const last=c.events.at(-1).slot;await s.verify(last,T0+last-100);await s.project();
  await s.db.query("INSERT INTO reward_history_queue(mint,signature,slot,fetched_at,events) VALUES($1,'broken-sig',$2,now(),0)",[s.mint,last-1]);
  await s.db.query("INSERT INTO reward_audit(kind,mint,actor,evidence) VALUES('parser_hold',$1,'indexer',$2)",[s.mint,JSON.stringify({signature:'broken-sig',holds:[{wallet:W[0],reason:'cpi_trace_incomplete',signature:'broken-sig'}]})]);
  const inp=await Pos.inputsAt(s.db,await s.coin(),T0+last-100,last);
  assert.ok(inp.owners.get(W[0]).holds.some(h=>h.reason==='cpi_trace_incomplete'));
 }finally{await s.db.close();}
});
