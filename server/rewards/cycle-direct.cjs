'use strict';
// Direct settlement rounds (no REBOUND program on chain; owner decision 2026-09-27).
//
// Same economics as V3: finalized history, losses in SOL, a snapshot `cutoffLead` seconds before each
// round ends, pro-rata awards capped at each holder's remaining loss. The difference is custody: the
// fee wallet's imported key signs plain SOL transfers to the recipients, in batches, at the end of
// the round. State machine per (mint, cycle):
//   scheduled → [waiting_for_data] → funded (awards reserved) → paying → complete
//                                   ↘ dry_run (execution is dry run or the key is missing: nothing reserved)
//                                   ↘ skipped_no_funds / skipped_no_eligible_holders / missed
// Rounds run one after another (owner decision 2026-09-27): a round whose snapshot is still catching up with
// the chain (history or positions behind its cutoff) is never dropped — it waits at the snapshot, the snapshot
// is taken at its cutoff slot once the data is verified, the payout follows `cutoffLead` seconds after that,
// and the next round starts when this one ends. Only a round whose snapshot can never be computed for its
// cutoff (no 15-minute price yet, a mint-level parser hold) is closed after a full round, as before.
// Guarantees:
//  * One worker per mint (row lease); a round's awards are fixed once and never recomputed.
//  * Every batch goes through transport-v3: execution gate + spend caps, signed bytes persisted before
//    broadcast, a batch is re-signed only after its previous transaction provably expired.
//  * Reserved awards count as compensation immediately (lot credits), so a holder is never paid twice
//    for the same loss; a round never reserves more than the budget left or the wallet can cover.
const {SystemProgram,PublicKey}=require('@solana/web3.js');
const DB=require('./db.cjs'),P3=require('./policy-v3.cjs'),S=require('./snapshot-v3.cjs'),T=require('./transport-v3.cjs');
const X=require('./execution.cjs'),Logs=require('./logs.cjs'),{stable}=require('./policy.cjs');
const b=x=>BigInt(String(x??0).split('.')[0]);
const BATCH=16,FEE_RESERVE=10_000_000n;
// Owner rule (2026-09-28): the holders' 85 % is a vault. A round pays out at most 20 % of what is in the
// vault at its snapshot, so the vault keeps refilling and every later round has money to pay. The other
// 15 % is never touched by payouts: whatever of it is still on the wallet stays out of every round.
const VAULT_ROUND_BPS=2000n;
const DONE=['complete','skipped_no_funds','skipped_no_eligible_holders','missed','expired','failed_action_required','dry_run'];
const cycleId=(mint,n)=>`${mint}:${n}`;
const PRE=['scheduled','snapshotting','waiting_for_data'];
// A round ends at its payout time: the scheduled end, or later when its snapshot waited for data.
const actualEnd=row=>Math.max(Number(row.scheduled_end),Number(row.due_at||0));
// Waits that end on their own as the indexer and the projection catch up with the chain.
const CATCHING_UP=new Set(['cutoff_slot_unproven','history_incomplete','history_behind_cutoff','positions_behind_cutoff']);
// ...but never forever: a round still catching up after this long is closed (an error for the operator), so one
// unreadable transaction or a pruned RPC cannot stop a token's rounds for good.
const maxWait=s=>Math.max(4*s.len,3600);

function schedule(coin){const p=P3.policy(coin.policy_version);return{anchor:Number(coin.schedule_anchor),len:Number(p.cycleSeconds),lead:Number(p.cutoffLeadSeconds)};}
function cycleAt(s,t){if(!s.anchor||t<s.anchor)return null;return Math.floor((t-s.anchor)/s.len)+1;}
function times(s,n){const start=s.anchor+(n-1)*s.len,end=start+s.len;return{start,end,cutoff:end-s.lead};}
// Rounds use the stored positions for SOL-unit policies. A USD-unit policy (v3.0, kept for history) prices
// each purchase with SOL/USD that may be backfilled later, so its rounds keep replaying the history.
const usePositions=(ports,coin)=>!!ports.positions&&P3.policy(coin.policy_version).lossUnit==='SOL';
async function log(db,e){try{await Logs.log(db,{component:'scheduler',...e});}catch{}}
async function liveWallet(db,mint){return(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[mint])).rows[0]||null;}

/**
 * Lamports the next round may reserve from a fee wallet: what is left of its budget, and never more than
 * the wallet holds after already-reserved unpaid awards and a 0.01 SOL fee reserve.
 */
async function available(db,connection,fw){
 if(fw&&fw.funding_model==='income')return incomeAvailable(db,connection,fw);
 if(!fw||!fw.budget_set_at||fw.budget_lamports==null)return{lamports:0n,reason:!fw?'no_fee_wallet':'budget_not_measured_yet'};
 if(fw.budget_requested_at&&new Date(fw.budget_set_at)<new Date(fw.budget_requested_at))return{lamports:0n,reason:'budget_not_measured_yet'};
 const lowered=b(fw.budget_balance_lamports)*BigInt(fw.budget_bps)/10000n,budget=lowered<b(fw.budget_lamports)?lowered:b(fw.budget_lamports);
 const q=(await db.query(`SELECT COALESCE(sum(a.amount_lamports) FILTER (WHERE a.reserved_at>=$2),0) used, COALESCE(sum(a.amount_lamports) FILTER (WHERE a.state IN ('reserved','deferred_rent')),0) unpaid
  FROM reward_awards a JOIN reward_cycles c ON c.id=a.cycle_id WHERE c.funding_wallet=$1 AND a.state IN ('reserved','paid','deferred_rent')`,[fw.id,fw.budget_set_at])).rows[0];   // "used" = reserved at or after the measurement
 const left=budget-b(q.used),bal=b(await connection.getBalance(new PublicKey(fw.address),'confirmed'))-FEE_RESERVE-b(q.unpaid);
 const v=left<bal?left:bal;return{lamports:v>0n?v:0n,budget,used:b(q.used),unpaid:b(q.unpaid),reason:v>0n?null:left<=0n?'budget_used_up':'wallet_balance_low'};
}

/**
 * Income model (policy 85/15): 85 % of the wallet's balance at launch and of every lamport that reaches it
 * later belongs to holders — the vault (the scheduler's per-transaction reconciliation splits it once; 15 %
 * stays on the wallet). A round may reserve 20 % of what is in the vault and not yet taken by an award —
 * never more than the wallet can pay without touching the 15 % share still on it.
 */
async function incomeAvailable(db,connection,fw){
 if(fw.opening_slot==null)return{lamports:0n,reason:'income_ledger_not_opened_yet'};
 // The ledger's holder share not yet moved out of the wallet (reconciled payouts and program deposits are
 // already subtracted), minus awards that still have to leave it: reserved/deferred ones, and paid ones whose
 // transaction the reconciliation has not reached yet.
 const acc=(await db.query('SELECT holder_awaiting_transfer,other_settled FROM reward_funding_accounts WHERE mint=$1',[fw.mint])).rows[0];
 const awaiting=b(acc?.holder_awaiting_transfer),other=b(acc?.other_settled);
 const q=(await db.query(`SELECT COALESCE(sum(a.amount_lamports) FILTER (WHERE a.state IN ('reserved','deferred_rent')),0) unpaid,
   COALESCE(sum(a.amount_lamports) FILTER (WHERE a.state='paid' AND NOT EXISTS(SELECT 1 FROM reward_wallet_movements m WHERE m.id=a.settlement_signature||':holder')),0) pending
  FROM reward_awards a JOIN reward_cycles c ON c.id=a.cycle_id WHERE c.funding_wallet=$1 AND a.state IN ('reserved','paid','deferred_rent')`,[fw.id])).rows[0];
 // The 15 % share still on the wallet: everything credited to it, less what already left the wallet other
 // than payouts (owner withdrawals, and for launched coins the buy-and-burn of that share).
 const out=b((await db.query("SELECT COALESCE(sum(lamports),0)::text s FROM reward_wallet_movements WHERE mint=$1 AND address=$2 AND classification='owner_withdrawal'",[fw.mint,fw.address])).rows[0].s);
 const kept=other>out?other-out:0n;
 let vault=awaiting-b(q.unpaid)-b(q.pending);if(vault<0n)vault=0n;
 const round=vault*VAULT_ROUND_BPS/10000n,bal=b(await connection.getBalance(new PublicKey(fw.address),'confirmed'))-FEE_RESERVE-b(q.unpaid)-kept;
 const v=round<bal?round:bal;return{lamports:v>0n?v:0n,budget:awaiting,vault,used:b(q.pending),unpaid:b(q.unpaid),kept,reason:v>0n?null:vault<=0n?'no_new_fees':'wallet_balance_low'};
}
// Reserved-but-unpaid awards of a fee wallet (lamports still owed from its balance).
async function unpaidOf(db,fwId){return b((await db.query("SELECT COALESCE(sum(a.amount_lamports),0) s FROM reward_awards a JOIN reward_cycles c ON c.id=a.cycle_id WHERE c.funding_wallet=$1 AND a.state IN ('reserved','deferred_rent')",[fwId])).rows[0].s);}
async function publishCycle(db,id,extra={}){
 await db.query(`INSERT INTO reward_public_cycles(mint,cycle_number,state,cutoff_time,scheduled_end,total_lamports,recipients,mode,holders_counted,holders_underwater,total_loss_lamports,available_lamports,reason)
  SELECT mint,cycle_number,state,cutoff_time,scheduled_end,total_lamports,eligible_count,$2,$3,$4,$5,$6,left(reason,80) FROM reward_cycles WHERE id=$1
  ON CONFLICT(mint,cycle_number) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,total_lamports=EXCLUDED.total_lamports,recipients=EXCLUDED.recipients,mode=EXCLUDED.mode,
   holders_counted=COALESCE(EXCLUDED.holders_counted,reward_public_cycles.holders_counted),holders_underwater=COALESCE(EXCLUDED.holders_underwater,reward_public_cycles.holders_underwater),
   total_loss_lamports=COALESCE(EXCLUDED.total_loss_lamports,reward_public_cycles.total_loss_lamports),available_lamports=COALESCE(EXCLUDED.available_lamports,reward_public_cycles.available_lamports)`,
  [id,extra.mode||'live',extra.counted??null,extra.underwater??null,extra.loss??null,extra.available??null]);
}
async function setState(db,id,state,fields={},{mint,cycle,message,severity,mode}={}){
 const cols=Object.keys(fields),vals=Object.values(fields);
 await db.query(`UPDATE reward_cycles SET state=$2${cols.map((c,i)=>`,${c}=$${i+3}`).join('')} WHERE id=$1`,[id,state,...vals]);
 await publishCycle(db,id,{mode:mode||(state==='dry_run'?'dry_run':'live')});
 if(message!==null)await log(db,{severity:severity||(['missed','failed_action_required'].includes(state)?'warn':'info'),eventType:'cycle_'+state,mint,cycleId:id,message:message||`Round ${cycle} → ${state.replaceAll('_',' ')}`});
}

/** One scheduler pass for a direct-settlement coin. */
async function tick(ports,coin){
 const {db}=ports;
 return DB.withLease(db,'coin:'+coin.mint,ports.worker||'worker',async({renew})=>{
  // Newly verified events → positions (never past a round still waiting for its snapshot).
  const t=await ports.now();
  if(ports.positions)await ports.positions.project(coin,{deadline:Date.now()+(ports.displayBudgetMs||20000),now:t}).catch(e=>log(db,{severity:'error',eventType:'positions_failed',mint:coin.mint,message:e.message,errorCode:e.code||'POSITIONS_FAILED'}));
  const s=schedule(coin);if(!s.anchor)return{state:'not_started'};
  // A token that is not active (e.g. paused by a funding incident) still pays awards it already funded, but
  // takes no new snapshot and opens no round.
  if(coin.status!=='active'){
   // Rounds that were waiting for their snapshot when the token stopped are closed once a round has passed:
   // a token resuming later never pays on a stale snapshot.
   for(const r of (await db.query('SELECT * FROM reward_cycles WHERE mint=$1 AND state=ANY($2) AND cutoff_time<=$3',[coin.mint,PRE,String(t-s.len)])).rows)
    await setState(db,r.id,'missed',{reason:'token_inactive'},{mint:r.mint,cycle:Number(r.cycle_number),message:`Round ${r.cycle_number} closed: the token is not active; nothing was reserved`});
   const pay=(await db.query("SELECT * FROM reward_cycles WHERE mint=$1 AND state IN ('funded','paying','partially_paid','retrying') ORDER BY cycle_number",[coin.mint])).rows;
   const results=[];for(const row of pay)results.push(await advance(ports,coin,s,row,t,renew));return{state:'inactive',now:t,results};}
  const fw=await liveWallet(db,coin.mint);
  const open=(await db.query(`SELECT * FROM reward_cycles WHERE mint=$1 AND state<>ALL($2) ORDER BY cycle_number`,[coin.mint,DONE])).rows;
  const results=[];for(const row of open)results.push(await advance(ports,coin,s,row,t,renew));
  // The next round opens only when the previous one has taken its snapshot and ended; it starts where the
  // previous one ended (after a long outage: the current slot of the schedule — never retroactive rounds).
  const last=(await db.query('SELECT * FROM reward_cycles WHERE mint=$1 ORDER BY cycle_number DESC LIMIT 1',[coin.mint])).rows[0];
  let n=null,w=null;
  if(!last){n=cycleAt(s,t);if(n)w=times(s,n);}
  else if(!PRE.includes(last.state)&&t>=actualEnd(last)){
   const prevEnd=actualEnd(last);
   if(t-prevEnd<s.len){n=Number(last.cycle_number)+1;w={start:prevEnd,end:prevEnd+s.len,cutoff:prevEnd+s.len-s.lead};}
   else{const g=cycleAt(s,t),gw=g?times(s,g):null;n=Number(last.cycle_number)+1;
    // After an outage: back on the anchor grid when that slot follows the last round; otherwise a fresh round from now.
    if(g&&g>=n&&gw.start>=prevEnd){n=g;w=gw;}else w={start:t,end:t+s.len,cutoff:t+s.len-s.lead};}}
  if(n&&w&&!(await db.query('SELECT 1 FROM reward_cycles WHERE id=$1',[cycleId(coin.mint,n)])).rows.length){
   await db.query(`INSERT INTO reward_cycles(id,deployment,mint,cycle_number,namespace,policy_version,config_version,anchor,cycle_start,scheduled_end,cutoff_time,state,due_at,funding_mode,funding_wallet)
    VALUES($1,NULL,$2,$3,$4,$5,0,$6,$7,$8,$9,'scheduled',$8,'automatic',$10) ON CONFLICT DO NOTHING`,[cycleId(coin.mint,n),coin.mint,n,coin.namespace,coin.policy_version,String(s.anchor),String(w.start),String(w.end),String(w.cutoff),fw?.id||null]);
   await publishCycle(db,cycleId(coin.mint,n));
   await db.query('UPDATE reward_public_tokens SET next_cycle_at=$2,last_cycle=$3 WHERE mint=$1',[coin.mint,String(w.end),n]);
   results.push(await advance(ports,coin,s,(await db.query('SELECT * FROM reward_cycles WHERE id=$1',[cycleId(coin.mint,n)])).rows[0],t,renew));
  }
  return{state:'ok',now:t,cycle:n,results};
 },{seconds:120,busy:()=>({state:'busy'})});
}

async function advance(ports,coin,s,row,t,renew){
 const {db}=ports,n=Number(row.cycle_number),cutoff=Number(row.cutoff_time),due=Number(row.due_at),ctx={mint:row.mint,cycle:n};
 switch(row.state){
  case'scheduled':case'snapshotting':case'waiting_for_data':{
   // Only a wait that cannot end for this cutoff closes the round (after a full round); catching up never does.
   if(t>=cutoff+s.len&&row.state==='waiting_for_data'&&row.reason&&!CATCHING_UP.has(row.reason)){
    await setState(db,row.id,'missed',{},{...ctx,message:`Round ${n} closed without a snapshot: ${row.reason.replaceAll('_',' ')} (this cannot resolve for its cutoff); nothing was reserved`});return{cycle:n,state:'missed',reason:row.reason};}
   if(t>=cutoff+maxWait(s)&&PRE.includes(row.state)){
    await setState(db,row.id,'missed',{reason:'data_wait_exceeded'},{...ctx,severity:'error',message:`Round ${n} closed: its snapshot data was still not verified ${Math.round((t-cutoff)/60)} min after the cutoff (${(row.reason||'waiting').replaceAll('_',' ')}); nothing was reserved — check the indexer`});return{cycle:n,state:'missed',reason:'data_wait_exceeded'};}
   if(t<cutoff)return{cycle:n,state:row.state};
   const slot=await ports.cutoffSlot(cutoff);if(slot==null){if(row.state!=='waiting_for_data'||row.reason!=='cutoff_slot_unproven')await setState(db,row.id,'waiting_for_data',{reason:'cutoff_slot_unproven'},{...ctx,message:null});return{cycle:n,state:'waiting_for_data'};}
   // Ready-made positions are brought exactly to the cutoff slot; a round never pays on history that is not
   // verified through its cutoff — it waits (and is missed, paying nothing, if that takes a whole round).
   if(usePositions(ports,coin)){
    const pr=await ports.positions.project(coin,{target:slot});
    if(!pr.ready){const reason=pr.verifiedSlot<slot?'history_behind_cutoff':'positions_behind_cutoff';
     if(row.state!=='waiting_for_data'||row.reason!==reason)await setState(db,row.id,'waiting_for_data',{reason},{...ctx,message:`Round ${n} waiting for data: ${reason.replaceAll('_',' ')} (verified through slot ${pr.verifiedSlot}, positions at ${pr.appliedSlot}, cutoff slot ${slot})`});
     return{cycle:n,state:'waiting_for_data',reason};}
   }
   return snapshot(ports,coin,row,slot,t,s);
  }
  case'funded':case'paying':case'partially_paid':case'retrying':return t>=due?pay(ports,coin,row,renew):{cycle:n,state:row.state};
  default:return{cycle:n,state:row.state};
 }
}

async function snapshot(ports,coin,row,slot,t=null,s=null){
 const {db,connection}=ports,n=Number(row.cycle_number),cutoff=Number(row.cutoff_time),ctx={mint:row.mint,cycle:n};
 // Always the token's CURRENT fee wallet: a round never snapshots against a retired one.
 const fw=await liveWallet(db,row.mint);
 const mode=await X.effectiveMode(db,coin.namespace,{env:ports.env});
 const keyReady=!!(fw&&fw.mode==='automatic'&&fw.signer);
 const why=mode.paused?'paused':mode.mode==='dry_run'?'dry_run':!keyReady?'fee_wallet_key_missing':null;
 const avail=await available(db,connection,fw);
 const fromPos=usePositions(ports,coin);
 const inputs=fromPos?await ports.positions.inputsAt(coin,cutoff,slot):await ports.inputs(coin,n,cutoff,slot);
 const snap=(fromPos?S.fromPositions:S.build)({...inputs,mint:row.mint,cycle:n,cutoff,cutoffSlot:slot,holderReserve:avail.lamports,policy:P3.policy(coin.policy_version)});
 if(snap.state==='waiting_for_data'){if(row.state!=='waiting_for_data'||row.reason!==snap.reason)await setState(db,row.id,'waiting_for_data',{reason:snap.reason},{...ctx,message:`Round ${n} waiting for data: ${snap.reason.replaceAll('_',' ')}`});return{cycle:n,state:'waiting_for_data',reason:snap.reason};}
 const underwater=snap.positions.filter(p=>p.outcome==='eligible'),counted=snap.positions.filter(p=>P3.big(p.quantity)>0n).length;
 const totalLoss=underwater.reduce((a,p)=>a+P3.big(p.lossUsd),0n),total=sumOf(snap.awards.map(a=>a.lamports));
 const live=snap.state==='ready'&&!why;
 const state=snap.state!=='ready'?snap.state:live?'funded':'dry_run';
 const reason=snap.state==='skipped_no_funds'?(avail.reason||'no_funds'):snap.state==='ready'&&!live?why:null;
 // One transaction: snapshot, awards, public projections and (live) the reservation itself. A crash
 // leaves either nothing or the complete, reserved round — never awards without their credits.
 let applied=false;
 await DB.transaction(db,async tx=>{
  const u=await tx.query(`UPDATE reward_cycles SET cutoff_slot=$2,snapshot_hash=$3,sol_usd_pico=$4,reference_price_q18=$5,holder_reserve_lamports=$6,budget_lamports=$7,total_lamports=$8,total_loss_usd=$9,eligible_count=$10,funding_wallet=$11,state=$12,reason=$13,funding_signature=$14
   WHERE id=$1 AND snapshot_hash IS NULL AND state IN ('scheduled','snapshotting','waiting_for_data')`,
   [row.id,slot,snap.snapshotHash,snap.price?.solUsdPico||null,snap.price?.referenceQ18||null,snap.holderReserve||'0',snap.budget||'0',snap.total||'0',snap.totalLossUsd||'0',snap.awards.length,fw?.id||null,state,reason,live?'direct':null]);
  if(!(u.rowCount??u.affectedRows))return;applied=true;
  // A snapshot taken after its cutoff (the round waited for data) keeps the full lead before the payout:
  // the round's end moves by the wait, and so does the start of the next round.
  if(t!=null&&s&&t>=Number(row.scheduled_end)){const end=t+s.lead;   // only a round that waited through its whole lead
   // The schedule itself is immutable (trigger): the round's actual end is its payout time (due_at).
   if(end>Number(row.scheduled_end)){await tx.query('UPDATE reward_cycles SET due_at=$2 WHERE id=$1',[row.id,String(end)]);
    await tx.query('UPDATE reward_public_cycles SET scheduled_end=$3 WHERE mint=$1 AND cycle_number=$2',[row.mint,n,String(end)]);
    await tx.query('UPDATE reward_public_tokens SET next_cycle_at=$2 WHERE mint=$1',[row.mint,String(end)]);}}
  const pos=snap.positions.map(p=>({owner:p.owner,outcome:p.outcome,reason:p.reason,quantity_raw:p.quantity,cost_usd:p.costUsd,value_usd:p.valueUsd,credit_usd:p.creditUsd,loss_usd:p.lossUsd,unrecognized_raw:p.unrecognized,lots:p.lots}));
  await tx.query(`INSERT INTO reward_snapshot_positions(cycle_id,owner,outcome,reason,quantity_raw,cost_usd,value_usd,credit_usd,loss_usd,unrecognized_raw,lots)
   SELECT $1,owner,outcome,reason,quantity_raw,cost_usd,value_usd,credit_usd,loss_usd,unrecognized_raw,lots FROM jsonb_to_recordset($2::jsonb) AS x(owner text,outcome text,reason text,quantity_raw numeric,cost_usd numeric,value_usd numeric,credit_usd numeric,loss_usd numeric,unrecognized_raw numeric,lots jsonb) ON CONFLICT DO NOTHING`,[row.id,JSON.stringify(pos)]);
  const awards=snap.awards.map(a=>({leaf_index:a.index,recipient:a.owner,amount_lamports:a.lamports,credit_usd:a.creditUsd,lot_credits:a.lotCredits}));
  await tx.query(`INSERT INTO reward_awards(cycle_id,leaf_index,mint,recipient,amount_lamports,credit_usd,lot_credits,proof,state,reserved_at)
   SELECT $1,leaf_index,$2,recipient,amount_lamports,credit_usd,lot_credits,'[]'::jsonb,$4,$5 FROM jsonb_to_recordset($3::jsonb) AS x(leaf_index int,recipient text,amount_lamports numeric,credit_usd numeric,lot_credits jsonb)`,[row.id,row.mint,JSON.stringify(awards),live?'reserved':'planned',live?new Date().toISOString():null]);
  if(live){
   const credits=snap.awards.flatMap(a=>a.lotCredits.filter(c=>P3.big(c.creditUsd)>0n).map(c=>({leaf_index:a.index,lot_id:c.lotId,credit_usd:c.creditUsd})));
   if(credits.length)await tx.query(`INSERT INTO reward_lot_credits(cycle_id,leaf_index,lot_id,credit_usd) SELECT $1,leaf_index,lot_id,credit_usd FROM jsonb_to_recordset($2::jsonb) AS x(leaf_index int,lot_id text,credit_usd numeric)`,[row.id,JSON.stringify(credits)]);
   if(fromPos)await ports.positions.applyCredits(tx,coin,slot,inputs.owners,snap.awards);   // positions stand at this slot
  }
  const hol=snap.positions.filter(p=>P3.big(p.quantity)>0n||p.outcome==='hold').map(p=>({owner:p.owner,quantity_raw:p.quantity,cost_lamports:p.costUsd,value_lamports:p.valueUsd,compensated_lamports:p.creditUsd,loss_lamports:p.lossUsd,outcome:p.outcome==='hold'?'hold:'+(p.reason||''):p.outcome}));
  await tx.query(`INSERT INTO reward_public_holders(mint,owner,quantity_raw,cost_lamports,value_lamports,compensated_lamports,loss_lamports,outcome,cycle_number,updated_at)
   SELECT $1,owner,quantity_raw,cost_lamports,value_lamports,compensated_lamports,loss_lamports,left(outcome,60),$2,now() FROM jsonb_to_recordset($3::jsonb) AS x(owner text,quantity_raw numeric,cost_lamports numeric,value_lamports numeric,compensated_lamports numeric,loss_lamports numeric,outcome text)
   ON CONFLICT(mint,owner) DO UPDATE SET quantity_raw=EXCLUDED.quantity_raw,cost_lamports=EXCLUDED.cost_lamports,value_lamports=EXCLUDED.value_lamports,compensated_lamports=EXCLUDED.compensated_lamports,loss_lamports=EXCLUDED.loss_lamports,outcome=EXCLUDED.outcome,cycle_number=EXCLUDED.cycle_number,updated_at=now()`,[row.mint,n,JSON.stringify(hol)]);
  await tx.query("UPDATE reward_public_holders SET quantity_raw=0,value_lamports=0,cost_lamports=0,loss_lamports=0,outcome='sold',cycle_number=$2,updated_at=now() WHERE mint=$1 AND cycle_number<$2 AND outcome<>'sold'",[row.mint,n]);
  await tx.query('UPDATE reward_public_tokens SET holders_underwater=$2,total_loss_lamports=$3,last_cycle=$4 WHERE mint=$1',[row.mint,underwater.length,String(totalLoss),n]);
 },{serializable:false});
 if(!applied)return{cycle:n,state:row.state,reason:'already_snapshotted'};
 await publishCycle(db,row.id,{counted,underwater:underwater.length,loss:String(totalLoss),available:String(avail.lamports),mode:live||snap.state!=='ready'&&!why?'live':'dry_run'});
 const head=`Round ${n}: ${underwater.length} of ${counted} holders underwater (${fmt(totalLoss)} SOL total loss); `;
 const message=snap.state==='skipped_no_funds'?head+'nothing available to pay ('+(avail.reason||'no funds').replaceAll('_',' ')+')'
  :snap.state!=='ready'?head+'nobody to pay'
  :live?head+`reserved ${fmt(total)} SOL for ${snap.awards.length} of them (${fmt(avail.lamports)} SOL available); paid at the end of the round`
  :head+`would pay ${fmt(total)} SOL to ${snap.awards.length} of them — nothing reserved or sent (${why.replaceAll('_',' ')})`;
 await log(db,{severity:live?'warn':'info',eventType:'cycle_'+state,mint:row.mint,cycleId:row.id,message});
 return{cycle:n,state,awards:snap.awards.length,total:String(total)};
}
const sumOf=xs=>xs.reduce((a,x)=>a+P3.big(x),0n);
const fmt=l=>{const v=b(l),s=String(v%1000000000n).padStart(9,'0').replace(/0+$/,'');return String(v/1000000000n)+(s?'.'+s:'');};
const DEFER_ROUNDS=3;   // an award whose recipient account still cannot receive it after this many rounds is released

async function pay(ports,coin,row,renew=async()=>{}){
 const {db,connection}=ports,n=Number(row.cycle_number),ctx={mint:row.mint,cycle:n};
 const mode=await X.effectiveMode(db,coin.namespace,{env:ports.env});if(mode.paused)return{cycle:n,state:row.state,reason:'paused'};
 const fw=(await db.query('SELECT * FROM reward_funding_wallets WHERE id=$1',[row.funding_wallet])).rows[0];
 const signer=fw?.mode==='automatic'&&fw.signer?await ports.signer(fw).catch(e=>{log(db,{severity:'error',eventType:'fee_wallet_signer_failed',mint:row.mint,message:'Fee wallet key cannot be loaded: '+e.message,errorCode:e.code});return null;}):null;
 if(!signer||signer.publicKey.toBase58()!==fw.address)return{cycle:n,state:row.state,reason:'fee_wallet_key_unavailable'};
 if(row.state==='funded')await setState(db,row.id,'paying',{submitted_at:new Date().toISOString()},{...ctx,message:null});
 const settlement=async sig=>{if(!sig)return{definitivelyUnsettled:true};const st=(await connection.getSignatureStatuses([sig],{searchTransactionHistory:true})).value[0];
  if(st?.confirmationStatus==='finalized'&&!st.err)return{settled:true,slot:st.slot,signature:sig};return{definitivelyUnsettled:true};};
 // 1. Every transaction ever made for this round decides first: landed ones are recorded as paid, and
 //    awards in a transaction that may still land are not touched until it provably expired.
 const locked=new Set();
 for(const att of (await db.query("SELECT * FROM reward_chain_attempts WHERE job LIKE $1 AND state IN ('prepared','broadcast','uncertain','finalized') ORDER BY created_at",[`direct-pay:${row.id}:%`])).rows){
  let st=att.state,sig=att.signature;
  if(st!=='finalized'){const r=await T.reconcile(db,connection,att,settlement);st=r.state;sig=r.signature||sig;}
  if(st==='finalized')await markPaid(db,row,att.context?.indexes||[],sig);
  else if(st!=='expired'&&st!=='failed')for(const i of att.context?.indexes||[])locked.add(i);
 }
 // 2. Long-deferred awards are released (their credits stop counting, the budget is freed).
 const age=Number(coin.cycle_seconds||P3.policy(coin.policy_version).cycleSeconds)*DEFER_ROUNDS;
 if(Number(await ports.now())>actualEnd(row)+age){
  const rel=(await db.query("UPDATE reward_awards SET state='released' WHERE cycle_id=$1 AND state='deferred_rent' RETURNING leaf_index",[row.id])).rows;
  if(rel.length)await log(db,{severity:'warn',eventType:'awards_released',mint:row.mint,cycleId:row.id,message:`Round ${n}: ${rel.length} award(s) released — the recipient account could not receive SOL for ${DEFER_ROUNDS} rounds`});
 }
 // 3. New transactions for everything still reserved and not locked.
 const awards=(await db.query("SELECT * FROM reward_awards WHERE cycle_id=$1 AND state IN ('reserved','deferred_rent') ORDER BY leaf_index",[row.id])).rows.filter(a=>!locked.has(a.leaf_index));
 const rent=b(await connection.getMinimumBalanceForRentExemption(0));
 const send=async list=>{
  const job=`direct-pay:${row.id}:${list.map(a=>a.leaf_index).join('-')}`,lamports=sumOf(list.map(a=>a.amount_lamports));
  const r=await T.submit({db,connection,job,kind:'payout',signerRole:'primary_dev',feePayer:signer,
   instructions:list.map(a=>SystemProgram.transfer({fromPubkey:signer.publicKey,toPubkey:new PublicKey(a.recipient),lamports:BigInt(a.amount_lamports)})),
   readSettlement:settlement,spend:{namespace:coin.namespace,mint:row.mint,recipients:list.map(a=>a.recipient),lamports:String(lamports),fees:'5000',cycleId:row.id,kind:'payout'},
   context:{cycle:n,indexes:list.map(a=>a.leaf_index)}}).catch(e=>({state:'failed',error:e.message}));
  if(r.state==='finalized'){await markPaid(db,row,list.map(a=>a.leaf_index),r.signature||r.settlement?.signature);return r;}
  if(['blocked','dry_run'].includes(r.state))await log(db,{severity:'warn',eventType:'payout_blocked',mint:row.mint,cycleId:row.id,message:`Round ${n}: payment of ${list.length} holder(s) blocked — ${r.reason||r.code}`,errorCode:r.code});
  else if(r.state==='held'||r.state==='failed')await log(db,{severity:'warn',eventType:'payout_held',mint:row.mint,cycleId:row.id,message:`Round ${n}: payment of ${list.length} holder(s) not sent — ${(r.reason||r.error||r.state).replaceAll('_',' ')}`,metadata:{err:r.err||null}});
  return r;
 };
 for(let k=0;k<awards.length;k+=BATCH){
  const list=awards.slice(k,k+BATCH);await renew();
  const infos=await connection.getMultipleAccountsInfo(list.map(a=>new PublicKey(a.recipient)),'confirmed');
  const include=[];for(const [i,a] of list.entries()){if(infos[i]||b(a.amount_lamports)>=rent)include.push(a);else if(a.state!=='deferred_rent')await db.query("UPDATE reward_awards SET state='deferred_rent' WHERE cycle_id=$1 AND leaf_index=$2 AND state='reserved'",[row.id,a.leaf_index]);}
  if(!include.length)continue;
  const r=await send(include);
  // One bad recipient must not hold the others: a batch the simulation rejects is retried one by one.
  if(r.state==='held'&&r.reason==='simulation_failed'&&include.length>1)for(const a of include){await renew();await send([a]);}
 }
 const left=(await db.query("SELECT count(*)::int n, count(*) FILTER (WHERE state='deferred_rent')::int d FROM reward_awards WHERE cycle_id=$1 AND state IN ('reserved','deferred_rent')",[row.id])).rows[0];
 if(left.n===0){await setState(db,row.id,'complete',{finalized_at:new Date().toISOString()},{...ctx,message:`Round ${n} complete: every award paid`});return{cycle:n,state:'complete'};}
 const state=left.d===left.n?'partially_paid':'paying';
 if(state!==row.state&&!(row.state==='funded'&&state==='paying'))await setState(db,row.id,state,{},{...ctx,message:`Round ${n}: ${left.n} award(s) outstanding (${left.d} waiting for the recipient account to exist)`});
 return{cycle:n,state,pending:left.n};
}

async function markPaid(db,row,indexes,signature){
 if(!indexes.length||!signature)return;
 const paidNow=await DB.transaction(db,async tx=>{
  const paid=(await tx.query(`UPDATE reward_awards SET state='paid',settlement_signature=$3 WHERE cycle_id=$1 AND leaf_index=ANY($2::int[]) AND state IN ('reserved','deferred_rent') RETURNING recipient,amount_lamports`,[row.id,indexes,signature])).rows;
  if(!paid.length)return 0;
  const loss=new Map((await tx.query('SELECT owner,loss_usd FROM reward_snapshot_positions WHERE cycle_id=$1 AND owner=ANY($2::text[])',[row.id,paid.map(p=>p.recipient)])).rows.map(r=>[r.owner,r.loss_usd]));
  const rows=paid.map(p=>({owner:p.recipient,amount:String(p.amount_lamports),loss:String(loss.get(p.recipient)||'0')}));
  await tx.query(`INSERT INTO reward_public_payouts(mint,cycle_number,owner,amount_lamports,loss_lamports,signature) SELECT $1,$2,owner,amount,loss,$3 FROM jsonb_to_recordset($4::jsonb) AS x(owner text,amount numeric,loss numeric) ON CONFLICT DO NOTHING`,[row.mint,row.cycle_number,signature,JSON.stringify(rows)]);
  await tx.query(`UPDATE reward_public_holders h SET paid_lamports=h.paid_lamports+x.amount,payouts=h.payouts+1,updated_at=now() FROM jsonb_to_recordset($2::jsonb) AS x(owner text,amount numeric) WHERE h.mint=$1 AND h.owner=x.owner`,[row.mint,JSON.stringify(rows)]);
  const total=paid.reduce((a,p)=>a+b(p.amount_lamports),0n);
  await tx.query('UPDATE reward_public_cycles SET paid_lamports=paid_lamports+$3,paid_recipients=paid_recipients+$4 WHERE mint=$1 AND cycle_number=$2',[row.mint,row.cycle_number,String(total),paid.length]);
  await tx.query(`UPDATE reward_public_tokens SET paid_lamports=(SELECT COALESCE(sum(amount_lamports),0) FROM reward_public_payouts WHERE mint=$1),payouts=(SELECT count(*) FROM reward_public_payouts WHERE mint=$1),
   paid_recipients=(SELECT count(DISTINCT owner) FROM reward_public_payouts WHERE mint=$1) WHERE mint=$1`,[row.mint]);
  return paid.length;
 },{serializable:false});
 if(paidNow)await log(db,{severity:'warn',eventType:'payout_sent',mint:row.mint,cycleId:row.id,message:`Round ${row.cycle_number}: paid ${paidNow} holder(s) in one transaction`,metadata:{signature}});
}

module.exports={tick,available,schedule,cycleAt,times,unpaidOf,BATCH,FEE_RESERVE,VAULT_ROUND_BPS};
