'use strict';
const W=require('./wire.cjs');
const Q=10n**18n,MAX=2n**64n-1n;
const POLICY=Object.freeze({version:'rebound-sol-v2.1',asset:'native-SOL',holdersBps:8500,operationsBps:1500,cycleSeconds:1800,maturitySeconds:1800,priceWindowSeconds:1800,maxObservationGapSeconds:60,maxPriceAgeSeconds:30,minRealQuoteLamports:'5000000000',maxSpotTwapRatioBps:30000,maxEntryImpactBps:2500,indexLagSlots:96,authorizationSlots:20,fundingHistorySeconds:2592000,fundingWindowSeconds:86400,fundingMinimumLamports:'50000000',fundingDependenceBps:5000,newWalletSeconds:604800,maxIndependentOutflows:5,maxFundingDepth:3});
// PostgreSQL JSONB does not preserve insertion order. All evidence hashes and
// manifests use recursively sorted keys, identical before and after storage.
function stable(x){
 const normalize=v=>{
  if(typeof v==='bigint')return v.toString();
  if(v&&typeof v.toBase58==='function')return v.toBase58();
  if(v?.constructor?.name==='BN')return v.toString(10);
  if(v&&typeof v.toJSON==='function')return normalize(v.toJSON());
  if(Array.isArray(v))return v.map(normalize);
  if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,normalize(v[k])]));
  if(typeof v==='number'&&!Number.isFinite(v))throw Error('Non-finite evidence');return v;
 };return JSON.stringify(normalize(x));
}
const POLICY_HASH=W.hash(stable(POLICY)).toString('hex');
const int=x=>{if(typeof x==='number'&&!Number.isSafeInteger(x))throw Error('Unsafe integer');if(typeof x==='string'&&!/^\d+$/.test(x))throw Error('Expected unsigned integer');const n=BigInt(x);if(n<0n||n>MAX)throw Error('Integer out of range');return n;};
const wide=x=>{if(typeof x==='number'&&!Number.isSafeInteger(x)||typeof x==='string'&&!/^\d+$/.test(x))throw Error('Invalid fixed-point integer');const n=BigInt(x);if(n<0n||n>=2n**256n)throw Error('Fixed-point integer out of range');return n;};
const ceil=(n,d)=>{if(d<=0n||n<0n)throw Error('Invalid ratio');return(n+d-1n)/d;};
const sum=xs=>xs.reduce((a,b)=>a+int(b),0n);
const hold=reason=>({outcome:'hold',reason});
function split(receipt,remainder=0){receipt=int(receipt);remainder=int(remainder);if(remainder>=100n)throw Error('Invalid split carry');const h=(receipt*85n+remainder)/100n;return{holders:h,operations:receipt-h,remainder:(receipt*85n+remainder)%100n};}
function conserved(a){return int(a.receipts)===sum([a.unallocated,a.reserved,a.paid,a.operationsPayable,a.operationsPaid]);}
function price(observations,cutoff,coverage,policy=POLICY){
 if(!coverage?.complete||coverage.throughTime<cutoff||coverage.incident)return hold('incomplete_price_history');
 const start=cutoff-policy.priceWindowSeconds;
 const sorted=[...observations].filter(o=>o.time<=cutoff).sort((a,b)=>a.time-b.time||a.slot-b.slot);
 const invalid=sorted.findLastIndex(o=>o.invalidated),history=invalid<0?sorted:sorted.slice(invalid+1);
 const preceding=history.filter(o=>o.time<=start).at(-1);
 const all=[...(preceding?[preceding]:[]),...history.filter(o=>o.time>start)];
 if(all.some(o=>!o.finalized||!o.canonical||o.asset!=='native-SOL'||o.virtualQuote===undefined||o.base===undefined))return hold('unverified_price_market');
 // Each observation is a verified state, with actual quote reserves separate
 // from virtual reserves. PumpSwap virtual quote may be signed.
 const normalized=[];try{for(const o of all){const base=int(o.base),real=int(o.realQuote),virtual=BigInt(o.virtualQuote);if(!['curve','amm'].includes(o.quoteModel))return hold('unknown_reserve_model');const quote=o.quoteModel==='curve'?virtual:real+virtual;if(base===0n||real<BigInt(policy.minRealQuoteLamports)||quote<=0n)return hold('insufficient_liquidity');normalized.push({...o,q:quote*Q/base});}}catch{return hold('invalid_reserves');}
 let previous=normalized.filter(o=>o.time<=start).at(-1);
 if(!previous||start-previous.time>policy.maxObservationGapSeconds)return hold('incomplete_twap_window');
 let last=start,weighted=0n;const within=normalized.filter(o=>o.time>start&&o.time<=cutoff);
 for(const o of within){if(o.time-last>policy.maxObservationGapSeconds||o.market!==previous.market&&!o.continuityVerified)return hold('price_continuity_unverified');weighted+=previous.q*BigInt(o.time-last);last=o.time;previous=o;}
 if(cutoff-last>policy.maxPriceAgeSeconds)return hold('stale_price');weighted+=previous.q*BigInt(cutoff-last);
 const twap=ceil(weighted,BigInt(policy.priceWindowSeconds)),spot=previous.q;
 if(twap<=0n||spot<=0n)return hold('invalid_price');
 if((spot>twap?spot:twap)*10000n>(spot<twap?spot:twap)*BigInt(policy.maxSpotTwapRatioBps))return hold('price_circuit_breaker');
 return{outcome:'pass',q:spot>twap?spot:twap,spot,twap,cutoff,asset:'native-SOL',policy:POLICY_HASH};
}
function qualifyPurchase(e,coin,policy=POLICY){
 if(!e.success||!e.finalized||!e.complete||!e.provenanceComplete)return hold('purchase_provenance_incomplete');
 if(e.mint!==coin.mint||e.quoteAsset!=='native-SOL'||!['pump-curve','pump-canonical-amm'].includes(e.venue))return{outcome:'unrecognized',reason:'unsupported_purchase_route'};
 if(!e.canonical||e.creator!==coin.expectedCreator||int(e.creatorFee)===0n)return{outcome:'unrecognized',reason:'no_qualifying_creator_fee'};
 if(!e.owner||!e.quantity||!e.actualQuote||!e.prePriceQ)return hold('purchase_amounts_unproven');
 const quantity=int(e.quantity),quote=int(e.actualQuote),fees=int(e.unavoidableFees),fair=ceil(quantity*wide(e.prePriceQ),Q);
 if(!quantity||!fair)return hold('invalid_purchase');
 if(quote*10000n>fair*BigInt(10000+policy.maxEntryImpactBps))return hold('entry_price_impact_limit');
 const cost=quote+fees;if(cost>MAX)return hold('purchase_cost_overflow');
 return{outcome:'qualifying',lot:{id:e.id,mint:e.mint,wallet:e.owner,quantity,cost,at:e.time,slot:e.slot,maturesAt:e.time+policy.maturitySeconds,source:e.id,asset:'native-SOL',policy:POLICY_HASH}};
}
function position(lots,{wallet,mint,cutoff,priceQ,paid=0n,reserved=0n,disqualification,coverage,linkHolds=[],holdings}){
 if(disqualification)return{outcome:'disqualified',reason:disqualification.kind,evidence:disqualification.event,loss:0n};
 if(!coverage?.complete||coverage.incident)return hold('indexing_incomplete');
 const selected=lots.filter(l=>l.wallet===wallet&&l.mint===mint&&l.maturesAt<=cutoff);
 if(selected.some(l=>l.asset!=='native-SOL'||!l.continuouslyHeld||l.unresolved))return hold('holding_history_unresolved');
 const recognized=selected.filter(l=>!linkHolds.includes(l.id));
 const quantity=sum(recognized.map(l=>l.quantity)),cost=sum(recognized.map(l=>l.cost));
 if(int(holdings)<quantity)return hold('holding_balance_mismatch');
 if(!quantity)return{outcome:linkHolds.length?'hold':'awaiting_maturity',reason:linkHolds.length?'funding_purchase_unresolved':'no_matured_qualifying_purchase',quantity,cost,loss:0n};
 const value=ceil(quantity*wide(priceQ),Q),compensated=int(paid)+int(reserved),loss=cost>value+compensated?cost-value-compensated:0n;
 return{outcome:loss?'eligible':'no_remaining_loss',wallet,mint,quantity,cost,value,paid:int(paid),reserved:int(reserved),loss,lotIds:recognized.map(l=>l.id)};
}
function allocate(positions,available){
 available=int(available);const eligible=positions.filter(p=>p.outcome==='eligible'&&int(p.loss)>0n).sort((a,b)=>a.wallet.localeCompare(b.wallet));
 if(new Set(eligible.map(p=>p.wallet)).size!==eligible.length)throw Error('Duplicate wallet position');
 const totalLoss=sum(eligible.map(p=>p.loss)),budget=available<totalLoss?available:totalLoss;
 const awards=totalLoss?eligible.map(p=>({...p,amount:budget*int(p.loss)/totalLoss})).filter(p=>p.amount>0n).map((p,index)=>({...p,index})):[];
 const reserved=sum(awards.map(a=>a.amount));return{awards,totalLoss,budget,reserved,remainder:available-reserved};
}
function paymentCheck(candidate,current,{nowSlot,checkedThrough,issuedSlot,policy=POLICY}){
 if(candidate.settled)return{outcome:'settled'};
 if(current.uncertainBroadcast||!current.coverage?.complete||current.coverage.incident||!current.price||current.price.outcome!=='pass')return hold('fresh_evidence_unavailable');
 if(!Number.isSafeInteger(nowSlot)||checkedThrough>issuedSlot||issuedSlot>nowSlot||issuedSlot-checkedThrough>policy.indexLagSlots||nowSlot-issuedSlot>policy.authorizationSlots)return hold('index_lag');
 if(current.newerKnownExit||current.disqualification?.kind==='exit')return{outcome:'cancel',payable:0n,released:int(candidate.maximum),permanent:true,evidence:current.disqualification?.event||current.newerKnownExit};
 if(current.linkBlock)return{outcome:'cancel',payable:0n,released:int(candidate.maximum),permanent:false,evidence:current.linkBlock};
 if(current.position.outcome==='hold'||current.position.outcome==='awaiting_maturity')return hold(current.position.reason);
 const p=current.position,maximum=int(candidate.maximum),active=int(p.reserved);
 if(active<maximum)return hold('reservation_totals_mismatch');
 const other=active-maximum,cost=int(p.cost),value=int(p.value),comp=int(p.paid)+other;
 const shortfall=cost>value+comp?cost-value-comp:0n,payable=maximum<shortfall?maximum:shortfall;
 return{outcome:payable===maximum?'pass':payable?'reduce':'cancel',payable,released:maximum-payable,permanent:false,cost,value,holding:int(p.quantity),checkedThrough,expires:issuedSlot+policy.authorizationSlots};
}
function fundingEdges({purchase,transfers,recipientHistory,services=[],policy=POLICY}){
 if(!recipientHistory.complete||recipientHistory.startTime>purchase.time-policy.fundingHistorySeconds)return{edges:[],holds:[{purchase:purchase.id,reason:'funding_history_incomplete'}]};
 const trustedServices=new Set(services.filter(s=>s.verified&&s.evidence&&s.classification!=='private-wallet-verified').map(s=>s.address));
 const groups=new Map();for(const t of transfers){
  if(t.to!==purchase.wallet||t.time>purchase.time||t.time<purchase.time-policy.fundingWindowSeconds||t.isReward||trustedServices.has(t.from)||trustedServices.has(t.to))continue;
  const list=groups.get(t.from)||[];list.push(t);groups.set(t.from,list);
 }
 const edges=[],holds=[];for(const[source,items]of groups){
  const supported=items.filter(t=>t.asset==='native-SOL'||t.conversion?.verified&&t.conversion.outputAsset==='native-SOL');
  const n=sum(supported.map(t=>t.asset==='native-SOL'?t.amount:t.conversion.outputLamports));
  if(n<BigInt(policy.fundingMinimumLamports)||n*10000n<int(purchase.cost)*BigInt(policy.fundingDependenceBps))continue;
  if(int(recipientHistory.independentFunds)>=int(purchase.cost))continue; // gifts cannot contaminate an independently funded position
  const dependent=int(recipientHistory.independentFunds)*10000n<int(purchase.cost)*BigInt(10000-policy.fundingDependenceBps);
  const control=recipientHistory.firstActivityProven&&purchase.time-recipientHistory.firstActivity<=policy.newWalletSeconds&&recipientHistory.independentOutflows<=policy.maxIndependentOutflows;
  const trace=supported.every(t=>t.complete&&t.spentByPurchase===purchase.id&&t.sourceClassification==='private-wallet-verified');
  const evidence={source,recipient:purchase.wallet,purchase:purchase.id,amount:n,events:supported.map(t=>t.id),policy:POLICY_HASH,direction:'source-to-dependent-purchase',controlBasis:control?'proven-new-dependent-wallet':null};
  if(dependent&&control&&trace)edges.push({...evidence,status:'supported'});
  else holds.push({...evidence,reason:'material_funding_unresolved'});
 }
 return{edges,holds};
}
function linkedExclusion(wallet,mint,edges,exits,depth=POLICY.maxFundingDepth,seen=new Set()){
 if(depth<=0||seen.has(wallet))return null;seen=new Set(seen).add(wallet);
 for(const e of edges.filter(e=>e.recipient===wallet&&e.mint===mint&&e.status==='supported'&&!e.revoked)){
  const sale=exits.find(x=>x.wallet===e.source&&x.mint===mint);if(sale)return{kind:'funding-link',sale:sale.id,edges:[e.id]};
  const upstream=linkedExclusion(e.source,mint,edges,exits,depth-1,seen);if(upstream)return{...upstream,edges:[...upstream.edges,e.id]};
 }return null;
}
module.exports={Q,POLICY,POLICY_HASH,stable,int,wide,ceil,sum,split,conserved,price,qualifyPurchase,position,allocate,paymentCheck,fundingEdges,linkedExclusion};
