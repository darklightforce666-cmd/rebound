'use strict';
// Ready-made holder positions (migration 017).
//
// The indexer stores verified events; this projector applies each of them ONCE, in chain order, to the
// positions it touches (remaining FIFO lots, their SOL cost, compensation credits, token account balances).
// A round then only revalues the stored positions at the cutoff price: no history is fetched or replayed.
//
// Frontier rules (what makes the stored positions equal to one full replay):
//  * Events are applied only through the VERIFIED history frontier (checkpoint 'verified:<mint>': every
//    transaction at or before it is known) and never past the cutoff of a round that still waits for its
//    snapshot. So at the snapshot the positions stand exactly at the cutoff slot, and the round's award
//    credits are added right there — as a replay would add them.
//  * Whole slots only; the frontier is one slot number.
//  * Integrity on every pass: the number of stored events at or before the frontier and the number of
//    active award credits must equal what was applied. A late event (a transfer found after the frontier
//    passed it), a released award or a parser change resets the positions; they are rebuilt from the
//    stored events (no RPC), in bounded batches.
// Runs as the scheduler role under the coin lease: the only writer of positions, never racing a round.
const P3=require('./policy-v3.cjs'),L=require('./lots-v3.cjs'),H=require('./history-v3.cjs'),I=require('./indexer.cjs'),DB=require('./db.cjs');
const FX=require('./sol-usd.cjs'),Logs=require('./logs.cjs');
const b=x=>BigInt(String(x??0).split('.')[0]);
const BIG=['quantity','remainingQuantity','cost','remainingCost','costLamports','paidCredit','reservedCredit'];
const OPEN=['scheduled','snapshotting','waiting_for_data'],WINDOW_SLOTS=20000;

const lotOut=l=>{const o={...l};for(const k of BIG)if(o[k]!=null)o[k]=String(o[k]);return o;};
const lotIn=l=>{const o={...l};for(const k of BIG)if(o[k]!=null)o[k]=BigInt(o[k]);return o;};
const eventOf=e=>({id:e.id,mint:e.mint,signature:e.signature,path:e.instruction_path,eventIndex:e.event_index,slot:Number(e.slot),transactionIndex:e.transaction_index,order:e.execution_order,kind:e.kind,owner:e.owner,data:e.data,time:Number(e.data?.time)});
function excludedOf(coin){const m=H.marketAddresses(coin.mint);return new Set([m.curve,m.pool,m.poolAuthority,...[coin.intake,coin.treasury].filter(Boolean)]);}
function totals(lots,holds){
 let Q=0n,C=0n,K=0n,U=0n,pending=false;
 for(const l of lots){const q=b(l.remainingQuantity);if(q===0n)continue;
  if(l.kind==='purchase'){Q+=q;C+=b(l.remainingCost);K+=b(l.paidCredit)+b(l.reservedCredit);if(l.basisPending)pending=true;}else U+=q;}
 return{recognized:Q,cost:C,credit:K,unrecognized:U,pending,holds:holds.length};
}
// Public outcome of a live position at a price (same words as a round's snapshot).
function outcomeAt(t,holds,s18,exited=null){
 if(exited)return{outcome:'exited',value:0n,loss:0n};
 if(holds.length)return{outcome:'hold:'+String(holds[0].reason||'').slice(0,50),value:0n,loss:0n};
 if(t.recognized===0n)return{outcome:t.unrecognized>0n?'no_recognized_quantity':'sold',value:0n,loss:0n};
 if(s18==null)return{outcome:'price_unavailable',value:0n,loss:0n};
 const v=(t.recognized*b(s18)+P3.E18-1n)/P3.E18,loss=t.cost>v+t.credit?t.cost-v-t.credit:0n;
 return{outcome:loss>0n?'eligible':'no_remaining_loss',value:v,loss};
}

async function creditCount(db,mint,through){
 return Number((await db.query(`SELECT count(*)::bigint n FROM reward_lot_credits lc JOIN reward_awards a USING(cycle_id,leaf_index) JOIN reward_cycles c ON c.id=a.cycle_id
  WHERE a.mint=$1 AND a.state IN ('reserved','paid','deferred_rent') AND c.cutoff_slot<=$2`,[mint,through])).rows[0].n);
}
async function creditsBetween(db,mint,from,to){
 return(await db.query(`SELECT lc.lot_id,lc.credit_usd,a.state,c.cutoff_slot,a.cycle_id,a.leaf_index,a.recipient FROM reward_lot_credits lc JOIN reward_awards a USING(cycle_id,leaf_index) JOIN reward_cycles c ON c.id=a.cycle_id
  WHERE a.mint=$1 AND a.state IN ('reserved','paid','deferred_rent') AND c.cutoff_slot>$2 AND c.cutoff_slot<=$3`,[mint,from,to])).rows
  .map(r=>({slot:Number(r.cutoff_slot),lotId:r.lot_id,credit:b(r.credit_usd),state:'reserved',award:r.cycle_id+':'+r.leaf_index,owner:r.recipient}));   // one bucket: see applyCredits
}
// Earliest cutoff (unix s) of a round that still waits for its snapshot: events after it wait too.
async function capTime(db,coin,now=Math.floor(Date.now()/1000)){
 let cap=Number((await db.query('SELECT min(cutoff_time) m FROM reward_cycles WHERE mint=$1 AND snapshot_hash IS NULL AND state=ANY($2)',[coin.mint,OPEN])).rows[0].m||0)||null;
 const anchor=Number(coin.schedule_anchor||0),len=Number(coin.cycle_seconds||0),lead=Number(coin.cutoff_lead_seconds||0);
 if(coin.status==='active'&&anchor&&len&&now>=anchor){   // the current round before its row exists
  const n=Math.floor((now-anchor)/len)+1;
  for(const k of [n,n+1]){if((await db.query('SELECT 1 FROM reward_cycles WHERE mint=$1 AND cycle_number=$2',[coin.mint,k])).rows.length)continue;
   const cut=anchor+k*len-lead;cap=cap==null?cut:Math.min(cap,cut);break;}
 }
 return cap;
}
async function state(db,mint){
 await db.query('INSERT INTO reward_projection_state(mint) VALUES($1) ON CONFLICT DO NOTHING',[mint]);
 return(await db.query('SELECT * FROM reward_projection_state WHERE mint=$1',[mint])).rows[0];
}
async function reset(db,coin,reason){
 await DB.transaction(db,async tx=>{
  await tx.query('DELETE FROM reward_holder_positions WHERE mint=$1',[coin.mint]);
  await tx.query('DELETE FROM reward_holder_accounts WHERE mint=$1',[coin.mint]);
  await tx.query(`UPDATE reward_projection_state SET applied_slot=-1,applied_time=NULL,events_applied=0,credits_applied=0,lot_seq=0,mint_holds='[]'::jsonb,parser_version=$2,
   rebuilds=rebuilds+1,last_rebuild_reason=$3,last_rebuild_at=now(),updated_at=now() WHERE mint=$1`,[coin.mint,I.PARSER,reason]);
 },{serializable:false});
 await Logs.log(db,{severity:reason==='late_event'||reason==='award_credits_changed'?'warn':'info',component:'scheduler',eventType:'positions_rebuild',mint:coin.mint,message:`Holder positions are rebuilt from the stored history (${reason.replaceAll('_',' ')}); rounds wait until they reach the cutoff again`}).catch(()=>{});
}

/**
 * Apply verified events to the stored positions.
 * @param opts.target     stop exactly at this slot (a round's cutoff slot)
 * @param opts.maxEvents  events per batch (whole slots)
 * @param opts.deadline   ms timestamp: stop between batches
 * @returns {appliedSlot, verifiedSlot, ready (appliedSlot===target), applied (events this call), rebuilt}
 */
async function project({db},coin,{target=null,maxEvents=20000,deadline=Infinity,excluded=excludedOf(coin),now=null}={}){
 const mint=coin.mint,policy=P3.policy(coin.policy_version);
 let st=await state(db,mint),rebuilt=null;
 const vc=(await db.query('SELECT through_slot,through_time FROM reward_checkpoints WHERE name=$1',['verified:'+mint])).rows[0];
 const verified=vc?Number(vc.through_slot):-1,verifiedTime=vc?Number(vc.through_time):null;
 // Integrity: what is stored at or before the frontier must be exactly what was applied.
 let applied=Number(st.applied_slot);
 if(applied>=0){
  const ev=Number((await db.query('SELECT count(*)::bigint n FROM reward_events WHERE mint=$1 AND slot<=$2',[mint,applied])).rows[0].n);
  rebuilt=ev!==Number(st.events_applied)?'late_event':await creditCount(db,mint,applied)!==Number(st.credits_applied)?'award_credits_changed'
   :st.parser_version!==I.PARSER?'parser_changed':target!=null&&applied>Number(target)?'past_cutoff':null;
  if(rebuilt){await reset(db,coin,rebuilt);st=await state(db,mint);applied=-1;}
 }
 let limit=verified;if(target!=null)limit=Math.min(limit,Number(target));
 const cap=target!=null?null:await capTime(db,coin,now??undefined);
 let count=0;
 while(applied<limit&&Date.now()<deadline){
  const rows=(await db.query('SELECT * FROM reward_events WHERE mint=$1 AND slot>$2 AND slot<=$3 ORDER BY slot,transaction_index,execution_order,event_index LIMIT $4',[mint,applied,limit,maxEvents+1])).rows;
  let events=rows.map(eventOf),through,throughTime=null,stop=false;
  if(rows.length>maxEvents){   // whole slots only
   const last=events.at(-1).slot;events=events.filter(e=>e.slot<last);
   if(!events.length)events=(await db.query('SELECT * FROM reward_events WHERE mint=$1 AND slot=$2 ORDER BY transaction_index,execution_order,event_index',[mint,last])).rows.map(eventOf);
   through=events.at(-1).slot;
  }else if(cap!=null&&(verifiedTime==null||limit!==verified||verifiedTime>cap)){through=events.length?events.at(-1).slot:applied;stop=true;}
  else{through=limit;throughTime=limit===verified?verifiedTime:null;}
  // Never past a round that still waits for its snapshot.
  if(cap!=null){const i=events.findIndex(e=>e.time>cap);if(i>=0){through=i>0?events[i-1].slot:applied;events=events.slice(0,i);throughTime=null;stop=true;}}
  if(through<=applied){break;}
  if(events.length&&throughTime==null)throughTime=events.at(-1).time;
  await applyBatch(db,coin,st,{events,from:applied,through,throughTime,policy,excluded});
  count+=events.length;applied=through;st=await state(db,mint);
  if(stop)break;
 }
 await publish(db,coin,st).catch(()=>{});
 return{appliedSlot:Number(st.applied_slot),verifiedSlot:verified,ready:target!=null&&Number(st.applied_slot)===Number(target),applied:count,rebuilt};
}

async function applyBatch(db,coin,st,{events,from,through,throughTime,policy,excluded}){
 const mint=coin.mint;
 const credits=await creditsBetween(db,mint,from,through);
 const sigs=[...new Set(events.map(e=>e.signature))];
 // Parser holds of this slot range — also for transactions that produced no event at all (their slot comes
 // from the history queue).
 const parserHolds=(await db.query(`SELECT a.evidence FROM reward_audit a WHERE a.kind='parser_hold' AND a.mint=$1 AND (a.evidence->>'signature'=ANY($2::text[])
   OR EXISTS(SELECT 1 FROM reward_history_queue q WHERE q.mint=a.mint AND q.signature=a.evidence->>'signature' AND q.slot>$3 AND q.slot<=$4))`,[mint,sigs,from,through])).rows.flatMap(r=>r.evidence.holds||[]);
 // Everything the batch can touch: owners named by events, parser holds and credits, and every token
 // account of those owners (a holding is proven against the sum of the owner's accounts).
 const owners=new Set(),keys=new Set();
 for(const e of events){if(e.owner)owners.add(e.owner);if(e.data?.nextOwner)owners.add(e.data.nextOwner);
  for(const a of e.data?.accounts||[]){keys.add(a.account);if(a.owner)owners.add(a.owner);}}
 for(const h of parserHolds)if(h.wallet)owners.add(h.wallet);
 for(const c of credits)if(c.owner)owners.add(c.owner);
 const accRows=(await db.query('SELECT account,owner,amount FROM reward_holder_accounts WHERE mint=$1 AND (account=ANY($2::text[]) OR owner=ANY($3::text[]))',[mint,[...keys],[...owners]])).rows;
 const posRows=(await db.query('SELECT owner,lots,holds,exited FROM reward_holder_positions WHERE mint=$1 AND owner=ANY($2::text[])',[mint,[...owners]])).rows;
 const s={owners:new Map(posRows.map(r=>[r.owner,{lots:(r.lots||[]).map(lotIn),holds:r.holds||[],...(r.exited?{exited:r.exited}:{})}])),accounts:new Map(accRows.map(r=>[r.account,{owner:r.owner,amount:b(r.amount)}])),seq:Number(st.lot_seq)};
 let fx=()=>null;
 if(policy.lossUnit==='SOL')fx=t=>({time:Number(t),price:P3.LAMPORTS,conf:0n,source:'sol-unit'});
 else{const ts=events.filter(e=>e.kind==='purchase_candidate').map(e=>e.time);if(ts.length)fx=FX.lookup(await FX.load(db,Math.min(...ts)-60,Math.max(...ts)));}
 // A credit whose lot was fully consumed in an earlier batch (possible after a late outflow rebuilt the
 // positions) is absorbed by that closed lot in a full replay; stored positions drop closed lots, so such a
 // credit is recognized by its lot's source event (already applied) and skipped — never a token-wide hold.
 const open=new Set();for(const bk of s.owners.values())for(const l of bk.lots)open.add(l.id);
 const missing=credits.filter(c=>!open.has(c.lotId));
 let closed=new Set();
 if(missing.length){const src=missing.map(c=>String(c.lotId).replace(/:(u|to)$/,''));
  const found=new Set((await db.query('SELECT id FROM reward_events WHERE mint=$1 AND id=ANY($2::text[]) AND slot<=$3',[mint,src,from])).rows.map(r=>r.id));
  closed=new Set(missing.filter(c=>found.has(String(c.lotId).replace(/:(u|to)$/,''))).map(c=>c.lotId));}
 const r=L.replay(events,{excluded,fx,credits:credits.filter(c=>!closed.has(c.lotId)),throughSlot:through,parserHolds,state:s,exitOnOutflow:!!policy.permanentExitOnSale});
 const holdKey=h=>h.reason+':'+(h.signature||h.lotId||'');
 const mintHolds=[...(st.mint_holds||[])];for(const h of r.mintHolds)if(!mintHolds.some(x=>holdKey(x)===holdKey(h)))mintHolds.push(h);
 const pos=[...r.owners.entries()].map(([owner,bk])=>{const lots=bk.lots.filter(l=>b(l.remainingQuantity)>0n),t=totals(lots,bk.holds);
  return{owner,lots:lots.map(lotOut),holds:bk.holds,exited:bk.exited||null,recognized_raw:String(t.recognized),unrecognized_raw:String(t.unrecognized),cost_lamports:String(t.cost),credit_lamports:String(t.credit),basis_pending:t.pending};});
 const acc=[...r.accounts.entries()].map(([account,a])=>({account,owner:a.owner||null,amount:String(a.amount)}));
 await DB.transaction(db,async tx=>{
  const u=await tx.query(`UPDATE reward_projection_state SET applied_slot=$3,applied_time=COALESCE($4,applied_time),events_applied=events_applied+$5,credits_applied=credits_applied+$6,lot_seq=$7,mint_holds=$8,parser_version=$9,updated_at=now()
   WHERE mint=$1 AND applied_slot=$2`,[mint,from,through,throughTime,events.length,credits.length,r.seq,JSON.stringify(mintHolds),I.PARSER]);
  if(!(u.rowCount??u.affectedRows))throw Object.assign(Error('Positions changed underneath this batch'),{code:'POSITIONS_RACE'});
  if(pos.length)await tx.query(`INSERT INTO reward_holder_positions(mint,owner,lots,holds,exited,recognized_raw,unrecognized_raw,cost_lamports,credit_lamports,basis_pending,updated_slot,updated_at)
   SELECT $1,owner,lots,holds,exited,recognized_raw,unrecognized_raw,cost_lamports,credit_lamports,basis_pending,$2,now() FROM jsonb_to_recordset($3::jsonb) AS x(owner text,lots jsonb,holds jsonb,exited jsonb,recognized_raw numeric,unrecognized_raw numeric,cost_lamports numeric,credit_lamports numeric,basis_pending boolean)
   ON CONFLICT(mint,owner) DO UPDATE SET lots=EXCLUDED.lots,holds=EXCLUDED.holds,exited=EXCLUDED.exited,recognized_raw=EXCLUDED.recognized_raw,unrecognized_raw=EXCLUDED.unrecognized_raw,cost_lamports=EXCLUDED.cost_lamports,credit_lamports=EXCLUDED.credit_lamports,basis_pending=EXCLUDED.basis_pending,updated_slot=EXCLUDED.updated_slot,updated_at=now()`,
   [mint,through,JSON.stringify(pos)]);
  if(acc.length)await tx.query(`INSERT INTO reward_holder_accounts(mint,account,owner,amount,updated_slot) SELECT $1,account,owner,amount,$2 FROM jsonb_to_recordset($3::jsonb) AS x(account text,owner text,amount numeric)
   ON CONFLICT(mint,account) DO UPDATE SET owner=EXCLUDED.owner,amount=EXCLUDED.amount,updated_slot=EXCLUDED.updated_slot`,[mint,through,JSON.stringify(acc)]);
 },{serializable:false});
 await publishHolders(db,coin,pos).catch(()=>{});
}

// ---------------- round snapshot inputs ----------------
/** Inputs for a round snapshot from the stored positions (they must stand exactly at `cutoffSlot`). */
async function inputsAt(db,coin,cutoff,cutoffSlot){
 const mint=coin.mint,policy=P3.policy(coin.policy_version),st=await state(db,mint);
 const vc=(await db.query('SELECT through_slot FROM reward_checkpoints WHERE name=$1',['verified:'+mint])).rows[0];
 const rows=(await db.query("SELECT owner,lots,holds,exited FROM reward_holder_positions WHERE mint=$1 AND (jsonb_array_length(lots)>0 OR jsonb_array_length(holds)>0)",[mint])).rows;
 const owners=new Map(rows.sort((x,y)=>x.owner<y.owner?-1:x.owner>y.owner?1:0).map(r=>[r.owner,{lots:(r.lots||[]).map(lotIn),holds:r.holds||[],...(r.exited?{exited:r.exited}:{})}]));
 // Market states: every sample inside the price window, the last one before it, and all graduations and
 // invalidations — exactly what the reference price reads from a full replay.
 const start=Number(cutoff)-Number(policy.priceWindowSeconds);
 // The window is ~60 s (~150 slots); WINDOW_SLOTS bounds the index range generously.
 const win=[...(await db.query(`SELECT * FROM reward_events WHERE mint=$1 AND slot<=$2 AND slot>$2-$5 AND kind=ANY($3::text[]) AND (data->>'time')::bigint>$4`,[mint,cutoffSlot,L.MARKET_KINDS,start,WINDOW_SLOTS])).rows,
  ...(await db.query(`SELECT * FROM reward_events WHERE mint=$1 AND slot<=$2 AND kind IN ('graduation','market_invalidation')`,[mint,cutoffSlot])).rows].map(eventOf);
 const seen=new Set();for(let i=win.length-1;i>=0;i--){if(seen.has(win[i].id))win.splice(i,1);else seen.add(win[i].id);}
 const before=(await db.query(`SELECT * FROM reward_events WHERE mint=$1 AND slot<=$2 AND kind IN ('purchase_candidate','sale','pool_balances') AND (data->>'time')::bigint<=$3 ORDER BY slot DESC,transaction_index DESC,execution_order DESC,event_index DESC LIMIT 500`,[mint,cutoffSlot,start])).rows.map(eventOf);
 const lastBefore=before.map(L.observationFrom).filter(Boolean)[0];
 const observations=[...(lastBefore?[lastBefore]:[]),...win.sort(L.chainOrder).map(L.marketObservation).filter(Boolean)];
 const heartbeats=(await db.query('SELECT observed_at,quote_model,base_reserve,real_quote,virtual_quote,market FROM reward_price_observations WHERE mint=$1 AND heartbeat AND observed_at BETWEEN $2 AND $3',[mint,start-60,cutoff])).rows
  .map(r=>({time:Number(r.observed_at),market:r.quote_model==='curve'?'pump-curve':'pump-amm:'+r.market,s18:r.quote_model==='curve'?P3.curveS18({virtualSolReserves:r.virtual_quote,virtualTokenReserves:r.base_reserve}):P3.ammS18({quoteReserve:r.real_quote,baseReserve:r.base_reserve})}));
 const solSeries=policy.lossUnit==='SOL'?[]:await FX.load(db,start-120,cutoff);
 const mintHolds=[...(st.mint_holds||[])];
 for(const h of (await db.query("SELECT evidence FROM reward_audit WHERE kind='parser_hold' AND mint=$1",[mint])).rows.flatMap(r=>r.evidence.holds||[])){
  if(!h.wallet){mintHolds.push(h);continue;}
  if(!owners.has(h.wallet))owners.set(h.wallet,{lots:[],holds:[]});const bk=owners.get(h.wallet);
  if(!bk.holds.some(x=>x.reason===h.reason))bk.holds.push({reason:h.reason,signature:h.signature||null,slot:null});
 }
 return{owners,mintHolds,appliedSlot:Number(st.applied_slot),coverage:{complete:!!vc,throughSlot:vc?Number(vc.through_slot):0},observations,heartbeats,solSeries};
}
/**
 * Inside a round's reservation transaction: add the awards' lot credits to the positions (they stand at
 * the cutoff slot) and count them, so later batches and the integrity check agree.
 */
async function applyCredits(tx,coin,cutoffSlot,owners,awards){
 const lc=awards.flatMap(a=>a.lotCredits.filter(c=>P3.big(c.creditUsd??c.credit)>0n).map(c=>({owner:a.owner,lotId:c.lotId,credit:P3.big(c.creditUsd??c.credit)})));
 const u=await tx.query('UPDATE reward_projection_state SET credits_applied=credits_applied+$3,updated_at=now() WHERE mint=$1 AND applied_slot=$2',[coin.mint,cutoffSlot,lc.length]);
 if(!(u.rowCount??u.affectedRows))throw Object.assign(Error('Positions are not at the cutoff slot'),{code:'POSITIONS_RACE'});
 const touched=new Map();
 for(const c of lc){const bk=owners.get(c.owner),lot=bk?.lots.find(l=>l.id===c.lotId);if(!lot)throw Object.assign(Error('Credit lot missing from positions'),{code:'POSITIONS_CREDIT'});
  lot.reservedCredit=b(lot.reservedCredit)+c.credit;touched.set(c.owner,bk);}
 const pos=[...touched.entries()].map(([owner,bk])=>{const t=totals(bk.lots,bk.holds);return{owner,lots:bk.lots.filter(l=>b(l.remainingQuantity)>0n).map(lotOut),credit_lamports:String(t.credit)};});
 if(pos.length)await tx.query(`UPDATE reward_holder_positions p SET lots=x.lots,credit_lamports=x.credit_lamports,updated_at=now() FROM jsonb_to_recordset($2::jsonb) AS x(owner text,lots jsonb,credit_lamports numeric) WHERE p.mint=$1 AND p.owner=x.owner`,[coin.mint,JSON.stringify(pos)]);
 return lc.length;
}

// ---------------- public projection (live) ----------------
async function latestPrice(db,mint){
 const o=(await db.query('SELECT quote_model,base_reserve,real_quote,virtual_quote,observed_at FROM reward_price_observations WHERE mint=$1 ORDER BY observed_at DESC LIMIT 1',[mint])).rows[0];if(!o)return null;
 const s18=o.quote_model==='curve'?P3.curveS18({virtualSolReserves:o.virtual_quote,virtualTokenReserves:o.base_reserve}):P3.ammS18({quoteReserve:o.real_quote,baseReserve:o.base_reserve});
 return s18?{s18,time:Number(o.observed_at)}:null;
}
// Touched owners → public holders table (value and loss at the latest known price).
async function publishHolders(db,coin,pos){
 if(!pos.length)return;const p=await latestPrice(db,coin.mint);
 const rows=pos.map(x=>{const t={recognized:b(x.recognized_raw),unrecognized:b(x.unrecognized_raw),cost:b(x.cost_lamports),credit:b(x.credit_lamports)},o=outcomeAt(t,x.holds,p?.s18,x.exited);
  return{owner:x.owner,keep:t.recognized>0n||x.holds.length>0||!!x.exited,quantity_raw:String(t.recognized),cost_lamports:String(t.cost),value_lamports:String(o.value),compensated_lamports:String(t.credit),loss_lamports:String(o.loss),outcome:o.outcome};});
 const keep=rows.filter(r=>r.keep),gone=rows.filter(r=>!r.keep).map(r=>r.owner);
 if(keep.length)await db.query(`INSERT INTO reward_public_holders(mint,owner,quantity_raw,cost_lamports,value_lamports,compensated_lamports,loss_lamports,outcome,cycle_number,updated_at)
  SELECT $1,owner,quantity_raw,cost_lamports,value_lamports,compensated_lamports,loss_lamports,left(outcome,60),0,now() FROM jsonb_to_recordset($2::jsonb) AS x(owner text,quantity_raw numeric,cost_lamports numeric,value_lamports numeric,compensated_lamports numeric,loss_lamports numeric,outcome text)
  ON CONFLICT(mint,owner) DO UPDATE SET quantity_raw=EXCLUDED.quantity_raw,cost_lamports=EXCLUDED.cost_lamports,value_lamports=EXCLUDED.value_lamports,compensated_lamports=EXCLUDED.compensated_lamports,loss_lamports=EXCLUDED.loss_lamports,outcome=EXCLUDED.outcome,updated_at=now()`,[coin.mint,JSON.stringify(keep)]);
 if(gone.length)await db.query("UPDATE reward_public_holders SET quantity_raw=0,cost_lamports=0,value_lamports=0,loss_lamports=0,outcome='sold',updated_at=now() WHERE mint=$1 AND owner=ANY($2::text[]) AND outcome<>'sold'",[coin.mint,gone]);
}
// A new price revalues every live holder in one statement (no history involved). At most once a minute.
const REVALUE_SECONDS=60;
async function revalue(db,coin,st){
 const p=await latestPrice(db,coin.mint);if(!p)return false;
 const fresh=st.revalued_at&&Date.now()-new Date(st.revalued_at).getTime()<REVALUE_SECONDS*1000;
 if(fresh||(st.price_s18!=null&&String(st.price_s18)===String(p.s18)))return false;
 const s=String(p.s18),v='div(h.quantity_raw*$2::numeric+999999999999999999,1000000000000000000)';
 await db.query(`UPDATE reward_public_holders h SET value_lamports=${v},loss_lamports=greatest(h.cost_lamports-${v}-h.compensated_lamports,0),
  outcome=CASE WHEN h.cost_lamports-${v}-h.compensated_lamports>0 THEN 'eligible' ELSE 'no_remaining_loss' END,updated_at=now()
  WHERE h.mint=$1 AND h.quantity_raw>0 AND h.outcome IN ('eligible','no_remaining_loss','price_unavailable') AND h.value_lamports IS DISTINCT FROM ${v}`,[coin.mint,s]);
 await db.query('UPDATE reward_projection_state SET price_s18=$2,price_time=$3,revalued_at=now() WHERE mint=$1',[coin.mint,s,p.time]);
 return true;
}
async function publish(db,coin,st){
 await revalue(db,coin,st).catch(()=>{});
 const t=(await db.query('SELECT count(*) FILTER (WHERE loss_lamports>0)::int u, COALESCE(sum(loss_lamports),0)::text l FROM reward_public_holders WHERE mint=$1 AND outcome<>\'sold\'',[coin.mint])).rows[0];
 const p=(await db.query('SELECT price_s18 FROM reward_projection_state WHERE mint=$1',[coin.mint])).rows[0];
 await db.query(`UPDATE reward_public_tokens SET positions_slot=$2,positions_time=$3,price_s18=$4,holders_underwater=$5,total_loss_lamports=$6 WHERE mint=$1
  AND (positions_slot IS DISTINCT FROM $2 OR positions_time IS DISTINCT FROM $3 OR price_s18 IS DISTINCT FROM $4 OR holders_underwater IS DISTINCT FROM $5 OR total_loss_lamports IS DISTINCT FROM $6::numeric)`,
  [coin.mint,Number(st.applied_slot)>=0?Number(st.applied_slot):null,st.applied_time??null,p?.price_s18??null,t.u,t.l]);
}

module.exports={project,inputsAt,applyCredits,capTime,creditCount,excludedOf,outcomeAt,totals,lotIn,lotOut,revalue,latestPrice,REVALUE_SECONDS};
