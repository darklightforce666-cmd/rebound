'use strict';
// Cutoff snapshot + round proposal (spec §7.3, §9). Pure and deterministic: identical inputs give
// an identical snapshot hash. Nothing is invented: missing coverage, price or FX evidence yields
// `waiting_for_data` with the exact reason and no awards.
const P3=require('./policy-v3.cjs'),L=require('./lots-v3.cjs');
const str=v=>typeof v==='bigint'?v.toString():v;

/**
 * @param a.mint, a.cycle, a.cutoff (unix s), a.cutoffSlot (latest finalized slot with blockTime ≤ cutoff)
 * @param a.events         parsed finalized events of the mint (lots + market states)
 * @param a.parserHolds    parser holds
 * @param a.coverage       {complete, throughSlot} of event history
 * @param a.excluded       Set of non-holder owners (markets, authorities, program treasuries, inventory)
 * @param a.fx             time → SOL/USD observation for purchase costs
 * @param a.solSeries      SOL/USD observations around the cutoff (reference price & conversion)
 * @param a.heartbeats     extra verified market samples [{time, s18, market}]
 * @param a.credits        active award credits [{slot, lotId, credit, state}]
 * @param a.holderReserve  lamports available to this round (H)
 */
function build(a){
 const policy=a.policy||P3.POLICY,base={mint:a.mint,cycle:String(a.cycle),cutoff:Number(a.cutoff),cutoffSlot:a.cutoffSlot,policy:policy.version,policyHash:P3.hashOf(policy)};
 const wait=(reason,extra={})=>({...base,state:'waiting_for_data',reason,awards:[],positions:[],...extra});
 if(a.cutoffSlot==null)return wait('cutoff_slot_unproven');
 if(!a.coverage?.complete)return wait('history_incomplete',{coverage:a.coverage});
 if(Number(a.coverage.throughSlot)<Number(a.cutoffSlot))return wait('history_behind_cutoff',{coverage:a.coverage});
 const r=L.replay(a.events,{excluded:a.excluded,fx:a.fx,credits:a.credits||[],throughSlot:a.cutoffSlot,parserHolds:a.parserHolds||[]});
 if(r.mintHolds.length)return wait(r.mintHolds[0].reason,{mintHolds:r.mintHolds});
 const token=[...r.observations.filter(o=>!o.graduation),...(a.heartbeats||[])].filter(o=>o.time<=a.cutoff);
 // Graduation continuity: the first canonical pool state after a verified graduation event.
 const grad=r.observations.filter(o=>o.graduation).map(o=>o.time);
 for(const o of token)if(o.market?.startsWith('pump-amm')&&grad.some(t=>t<=o.time))o.continuityVerified=true;
 const price=P3.referencePrice({token,sol:a.solSeries||[],cutoff:Number(a.cutoff),coverage:{complete:true,throughTime:Number(a.cutoff),impliedHeartbeats:true},policy});
 if(price.outcome!=='pass')return wait(price.reason);
 const positions=[...r.owners.entries()].sort(([x],[y])=>x<y?-1:x>y?1:0).map(([owner,b])=>({owner,...P3.position(b.lots,{priceQ18:price.q18,holds:b.holds}),lotsDetail:b.lots}));
 const round=P3.allocateRound(positions,{holderReserve:a.holderReserve,solUsdPico:price.solUsd});
 const awards=round.awards.map(aw=>{const p=positions.find(x=>x.owner===aw.owner);return{index:aw.index,owner:aw.owner,lamports:aw.amount,creditUsd:aw.credit,lossUsd:aw.loss,lotCredits:P3.attributeCredit(aw.credit,p.lots)};});
 const eligible=positions.filter(p=>p.outcome==='eligible').length;
 const state=eligible===0?'skipped_no_eligible_holders':P3.big(a.holderReserve)===0n?'skipped_no_funds':awards.length?'ready':'skipped_no_funds';
 const publicPositions=positions.map(p=>({owner:p.owner,outcome:p.outcome,reason:p.reason||null,quantity:str(p.quantity??0n),costUsd:str(p.cost??0n),valueUsd:str(p.value??0n),creditUsd:str(p.credit??0n),lossUsd:str(p.loss??0n),unrecognized:str(p.unrecognized??0n),
  lots:(p.lotsDetail||[]).filter(l=>P3.big(l.remainingQuantity)>0n).map(l=>({id:l.id,kind:l.kind,remaining:str(l.remainingQuantity),remainingCostUsd:str(l.remainingCost),paidCreditUsd:str(l.paidCredit),reservedCreditUsd:str(l.reservedCredit),acquiredSlot:l.acquiredSlot,basisPending:l.basisPending||null}))}));
 const body={...base,state,price:{referenceQ18:str(price.q18),spotQ18:str(price.spot),twapQ18:str(price.twap),solUsdPico:str(price.solUsd),solUsdTime:price.solUsdTime,tokenTime:price.tokenTime},
  holderReserve:str(P3.big(a.holderReserve)),budget:str(round.budget),totalLossUsd:str(round.totalLoss),total:str(round.total),undistributed:str(round.undistributed),
  positions:publicPositions,awards:awards.map(x=>({index:x.index,owner:x.owner,lamports:str(x.lamports),creditUsd:str(x.creditUsd),lossUsd:str(x.lossUsd),lotCredits:x.lotCredits.map(c=>({lotId:c.lotId,creditUsd:str(c.credit)}))}))};
 return{...body,snapshotHash:P3.canonicalHash(body)};
}
module.exports={build};
