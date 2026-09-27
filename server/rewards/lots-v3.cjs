'use strict';
// V3 lot engine (spec §7.1–§7.2). Deterministic replay of finalized, CPI-ordered events for ONE
// mint into per-owner FIFO lots. Pure: no database, no network.
//
// Rules implemented here:
//  * A purchase lot exists only for a supported venue trade (Pump bonding curve or canonical
//    PumpSwap pool) whose trade event is matched to the actual SPL delivery of the same quantity
//    to the same owner inside the same route, and whose SOL payment by that owner is proven by
//    the owner's own transfers in that route. Cost = quote + unavoidable trade fees (no rent,
//    tips or network fees), converted at a valid historical SOL/USD price.
//  * Anything else that arrives (gifts, router intermediaries, side pools, owner changes) is an
//    unrecognized zero-basis lot: it contributes neither cost nor value.
//  * Outflows (transfers, burns, sales, owner changes) consume FIFO across ALL of the owner's
//    lots; cost and credits leave proportionally. Nothing bans a wallet.
//  * After every transaction each touched owner's reconstructed quantity must equal the real
//    post-transaction token balance; otherwise the owner is held (never guessed).
const P3=require('./policy-v3.cjs');
const SUPPORTED=new Set(['pump-curve','pump-canonical-amm']);
const n=x=>x==null||x===''?0n:BigInt(x);

function nonzero(e,a,b){const x=e[a];return x!==undefined&&x!==null&&BigInt(x)!==0n?BigInt(x):n(e[b]);}
// Inside a trade = below its CPI tree position (`data.tree`; flat `path` for events without one).
const at=x=>x.data?.tree??x.path;
const under=(path,root)=>path===root||path.startsWith(root+'/');

function tradeCost(trade,txEvents){
 const e=trade.data.event,buyer=trade.owner,route=trade.data.route;
 if(trade.data.venue==='pump-curve'){
  const quote=nonzero(e,'quoteAmount','solAmount'),total=quote+n(e.fee)+n(e.creatorFee);
  const paid=txEvents.filter(x=>x.kind==='funding_transfer'&&x.data.from===buyer&&under(at(x),route)).reduce((s,x)=>s+n(x.data.amount),0n);
  return paid>=total&&quote>0n?{lamports:total,quote,fees:total-quote}:null;
 }
 const total=e.userQuoteAmountIn!=null?n(e.userQuoteAmountIn):n(e.quoteAmountIn)+n(e.lpFee)+n(e.protocolFee)+n(e.coinCreatorFee);
 const paid=txEvents.filter(x=>x.kind==='quote_transfer'&&x.data.from===buyer&&under(at(x),route)).reduce((s,x)=>s+n(x.data.amount),0n);
 return paid>=total&&total>0n?{lamports:total,quote:n(e.quoteAmountIn),fees:total-n(e.quoteAmountIn)}:null;
}
function tradeQuantity(trade){const e=trade.data.event;return trade.data.venue==='pump-curve'?n(e.tokenAmount):n(e.baseAmountOut);}

function observationFrom(ev){
 const e=ev.data?.event;
 if((ev.kind==='purchase_candidate'||ev.kind==='sale')&&e&&e.virtualTokenReserves!=null&&(e.virtualSolReserves!=null||e.virtualQuoteReserves!=null)){
  const s18=P3.curveS18({virtualSolReserves:nonzero(e,'virtualQuoteReserves','virtualSolReserves'),virtualTokenReserves:n(e.virtualTokenReserves)});
  return s18?{time:ev.time,slot:ev.slot,s18,market:'pump-curve',evidence:ev.id}:null;
 }
 if(ev.kind==='pool_balances'){const s18=P3.ammS18({quoteReserve:ev.data.quote,baseReserve:ev.data.base});return s18?{time:ev.time,slot:ev.slot,s18,market:'pump-amm:'+ev.data.market,evidence:ev.id}:null;}
 return null;
}

/**
 * @param events   finalized events of this mint (any order; sorted here)
 * @param opts.excluded  Set of owners that are never holders (curve, pools, authorities,
 *                       program treasuries, burn/buyback inventory accounts)
 * @param opts.fx    time → {price, conf, time, source} | null   (historical SOL/USD)
 * @param opts.credits [{slot, lotId, credit, state:'reserved'|'paid', award}] active award credits,
 *                   applied immediately after all events of `slot` (the award's snapshot slot)
 * @param opts.throughSlot  replay events with slot ≤ throughSlot only
 * @param opts.parserHolds  holds reported by the parser ({wallet?, reason, signature})
 */
function replay(events,{excluded=new Set(),fx=()=>null,credits=[],throughSlot=Infinity,parserHolds=[],state=null,exitOnOutflow=false}={}){
 const ordered=events.filter(e=>Number(e.slot)<=Number(throughSlot)).sort(chainOrder);
 // `state` resumes a replay (ready-made positions): the owners and token accounts it touches, and the lot
 // counter. Applying events in batches on top of the stored state gives exactly the result of one replay.
 const owners=state?.owners||new Map(),accounts=state?.accounts||new Map(),observations=[],movements=[],mintHolds=[];let seq=state?Number(state.seq||0):0;
 const book=o=>{if(!owners.has(o))owners.set(o,{lots:[],holds:[]});return owners.get(o);};
 const hold=(o,reason,ev)=>{const b=book(o);if(!b.holds.some(h=>h.reason===reason))b.holds.push({reason,signature:ev?.signature||null,slot:ev?Number(ev.slot):null});};
 for(const h of parserHolds){if(h.wallet)hold(h.wallet,h.reason,h);else mintHolds.push(h);}
 const addLot=(owner,lot)=>{if(excluded.has(owner))return;book(owner).lots.push({...lot,order:seq++});};
 const consume=(owner,qty,ev)=>{
  if(excluded.has(owner)||qty===0n)return;const b=book(owner);
  try{const r=P3.consumeFifo(b.lots,qty);b.lots=r.lots;for(const m of r.movements)movements.push({...m,eventId:ev.id,kind:ev.kind==='burn'?'burn':ev.kind==='owner_change'?'owner_change':'disposal',slot:Number(ev.slot)});}
  catch(e){hold(owner,e.code||'holding_history_unresolved',ev);b.lots=b.lots.map(l=>({...l,remainingQuantity:0n,remainingCost:0n,paidCredit:0n,reservedCredit:0n}));}
 };
 // v3.2: the first sale or transfer to another wallet excludes the sender for good (buying again does not
 // restore it). Burns and moves between the owner's own accounts are not exits.
 const exit=(owner,ev,reason)=>{if(!exitOnOutflow||!owner||excluded.has(owner))return;const b=book(owner);if(!b.exited)b.exited={reason,signature:ev.signature||null,slot:Number(ev.slot)};};
 const pendingCredits=[...credits].sort((a,b)=>Number(a.slot)-Number(b.slot));
 // Apply credits whose snapshot slot is ≤ `slot` (i.e. before any event of a later slot).
 const applyCreditsThrough=slot=>{
  while(pendingCredits.length&&Number(pendingCredits[0].slot)<=slot){
   const c=pendingCredits.shift();let applied=false;
   for(const b of owners.values())for(const l of b.lots)if(l.id===c.lotId){if(c.state==='paid')l.paidCredit+=P3.big(c.credit);else l.reservedCredit+=P3.big(c.credit);applied=true;}
   if(!applied)mintHolds.push({reason:'credit_lot_missing',lotId:c.lotId,award:c.award});
  }
 };
 // Group by transaction, keep order.
 const groups=[];for(const ev of ordered){const last=groups.at(-1);if(last&&last.signature===ev.signature&&last.slot===ev.slot)last.events.push(ev);else groups.push({signature:ev.signature,slot:ev.slot,events:[ev]});}
 let lastSlot=null;
 for(const g of groups){
  applyCreditsThrough(Number(g.slot)-1);
  const txe=g.events,deliveries=txe.filter(x=>x.kind==='market_delivery'),matched=new Map();
  for(const t of txe.filter(x=>x.kind==='purchase_candidate'&&SUPPORTED.has(x.data.venue)&&x.data.quoteAsset==='native-SOL')){
   const q=tradeQuantity(t),d=deliveries.find(d=>!matched.has(d.id)&&n(d.data.amount)===q&&under(at(d),t.data.route));
   if(d)matched.set(d.id,t);else if(!excluded.has(t.owner))hold(t.owner,'purchase_delivery_unproven',t);
  }
  const touched=new Set();
  for(const ev of txe){
   const obs=marketObservation(ev);if(obs)observations.push(obs);
   switch(ev.kind){
    case'market_delivery':{
     const owner=ev.owner,qty=n(ev.data.amount);if(!owner||excluded.has(owner))break;touched.add(owner);
     const t=matched.get(ev.id);
     if(t&&t.owner===owner){
      const cost=tradeCost(t,txe),rate=cost?fx(Number(t.time)):null;
      const lot={id:t.id,kind:'purchase',sourceEvent:t.id,quantity:qty,remainingQuantity:qty,paidCredit:0n,reservedCredit:0n,acquiredAt:Number(t.time),acquiredSlot:Number(t.slot),venue:t.data.venue};
      if(!cost){addLot(owner,{...lot,costLamports:0n,cost:0n,remainingCost:0n,basisPending:'purchase_amounts_unproven'});hold(owner,'purchase_amounts_unproven',t);}
      else if(!rate){addLot(owner,{...lot,costLamports:cost.lamports,cost:0n,remainingCost:0n,basisPending:'fx_unavailable'});}
      else{const usd=P3.costUsd(cost.lamports,rate.price);addLot(owner,{...lot,costLamports:cost.lamports,cost:usd,remainingCost:usd,fx:{price:String(rate.price),time:rate.time,source:rate.source}});}
     }else addLot(owner,{id:ev.id+':u',kind:'unrecognized_incoming',sourceEvent:ev.id,quantity:qty,remainingQuantity:qty,cost:0n,remainingCost:0n,costLamports:0n,paidCredit:0n,reservedCredit:0n,acquiredAt:Number(ev.time),acquiredSlot:Number(ev.slot),reason:t?'buyer_is_not_recipient':'unmatched_market_delivery'});
     break;}
    case'transfer_exit':case'burn':{touched.add(ev.owner);consume(ev.owner,n(ev.data.amount),ev);
     if(ev.kind==='transfer_exit'&&n(ev.data.amount)>0n)exit(ev.owner,ev,excluded.has(ev.data.to)?'sold':'transferred');break;}
    case'incoming_transfer':{const qty=n(ev.data.amount);if(ev.owner&&!excluded.has(ev.owner)){touched.add(ev.owner);addLot(ev.owner,{id:ev.id+':u',kind:'unrecognized_incoming',sourceEvent:ev.id,quantity:qty,remainingQuantity:qty,cost:0n,remainingCost:0n,costLamports:0n,paidCredit:0n,reservedCredit:0n,acquiredAt:Number(ev.time),acquiredSlot:Number(ev.slot),reason:excluded.has(ev.data.from)?'unsupported_route':'transfer_without_purchase_basis'});}break;}
    case'owner_change':{
     if(ev.data.amount===''||ev.data.amount==null){hold(ev.owner,'owner_change_amount_unknown',ev);hold(ev.data.nextOwner,'owner_change_amount_unknown',ev);break;}
     const qty=n(ev.data.amount);touched.add(ev.owner);touched.add(ev.data.nextOwner);consume(ev.owner,qty,ev);if(qty>0n)exit(ev.owner,ev,'account_owner_changed');
     if(qty>0n&&!excluded.has(ev.data.nextOwner))addLot(ev.data.nextOwner,{id:ev.id+':to',kind:'unrecognized_incoming',sourceEvent:ev.id,quantity:qty,remainingQuantity:qty,cost:0n,remainingCost:0n,costLamports:0n,paidCredit:0n,reservedCredit:0n,acquiredAt:Number(ev.time),acquiredSlot:Number(ev.slot),reason:'account_owner_change'});
     break;}
    case'token_balances':{for(const a of ev.data.accounts){accounts.set(a.account,{owner:a.owner,amount:n(a.amount)});touched.add(a.owner);}break;}
   }
  }
  // Prove reconstructed holdings against real post-transaction balances.
  if(txe.some(x=>x.kind==='token_balances'))for(const owner of touched){
   if(!owner||excluded.has(owner))continue;let real=0n;for(const a of accounts.values())if(a.owner===owner)real+=a.amount;
   const b=book(owner),mine=b.lots.reduce((s,l)=>s+P3.big(l.remainingQuantity),0n);
   if(mine!==real)hold(owner,'holding_balance_mismatch',txe[0]);
  }
  lastSlot=Number(g.slot);
 }
 applyCreditsThrough(Number.isFinite(Number(throughSlot))?Number(throughSlot):(lastSlot??0));
 for(const c of pendingCredits)if(Number(c.slot)<=Number(throughSlot))mintHolds.push({reason:'credit_lot_missing',lotId:c.lotId,award:c.award});
 return{owners,accounts,seq,observations,movements,mintHolds,throughSlot:lastSlot};
}
const chainOrder=(a,b)=>Number(a.slot)-Number(b.slot)||a.transactionIndex-b.transactionIndex||a.order-b.order||(a.eventIndex||0)-(b.eventIndex||0);
// Market state (price sample, graduation, invalidation) carried by one event, or null.
function marketObservation(ev){
 if(ev.kind==='graduation')return{time:ev.time,slot:ev.slot,market:'graduation',graduation:true,evidence:ev.id};
 if(ev.kind==='market_invalidation')return{time:ev.time,slot:ev.slot,invalidated:true,evidence:ev.id};
 return observationFrom(ev);
}
const MARKET_KINDS=['purchase_candidate','sale','pool_balances','graduation','market_invalidation'];
module.exports={SUPPORTED,replay,tradeCost,tradeQuantity,observationFrom,marketObservation,MARKET_KINDS,chainOrder};
