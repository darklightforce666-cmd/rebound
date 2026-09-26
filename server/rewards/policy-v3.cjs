'use strict';
// REBOUND reward policy V3 — the single source of the economic constants.
// docs/POLICY-V3.md explains every value. Changing any value changes the policy hash,
// which is bound into database rows, round manifests and the V3 program configuration.
const W=require('./wire.cjs');
const {stable}=require('./policy.cjs');

const BASE=Object.freeze({
 asset:'native-SOL',
 lossUnit:'USD',
 usdScale:'1000000000000',            // usd_pico per USD
 priceScale:'1000000000000000000',    // Q18: usd_pico per raw token unit × 10^18
 holdersBps:8500, otherBps:1500,      // split once at the funding boundary
 primaryOther:'retain_on_dev_wallet', thirdPartyOther:'buy_and_burn_primary',
 accounting:'fifo_lots_proportional_integer',
 maturitySeconds:0,
 laterActivity:'funded_award_survives',
 walletLinkExclusion:false, permanentExitOnSale:false,
 transferBasis:'none_for_unproven_incoming',
 referencePrice:'max(spot,twap)', priceWindowSeconds:60,
 maxPriceAgeSeconds:30, maxObservationGapSeconds:30,
 solUsd:{source:'pyth',feedId:'0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',maxAgeSeconds:30,maxConfidenceBps:100},
 minRealQuoteLamports:'0', maxSpotTwapRatioBps:30000,
 buybackMaxSlippageBps:100, buybackHardCapSlippageBps:300, buybackMaxImpactBps:200,
 venues:['pump-curve','pump-amm'],
 pumpHolderRewardMode:false,
 rentPolicy:'defer_undeliverable_as_liability',
});
const POLICY=Object.freeze({...BASE,version:'rebound-v3.0',kind:'production',cycleSeconds:1800,cutoffLeadSeconds:60});
const TEST_POLICY=Object.freeze({...BASE,version:'rebound-v3.0-test',kind:'test',cycleSeconds:120,cutoffLeadSeconds:30});
const hashOf=p=>W.hash(stable(p)).toString('hex');
const POLICY_HASH=hashOf(POLICY),TEST_POLICY_HASH=hashOf(TEST_POLICY);
const POLICIES=Object.freeze({[POLICY.version]:POLICY,[TEST_POLICY.version]:TEST_POLICY});
function policy(version){const p=POLICIES[version];if(!p)throw Error('Unknown policy version');return p;}

// Persist both policy versions (immutable rows) and the platform namespaces. Idempotent.
async function seed(db){
 for(const p of [POLICY,TEST_POLICY])await db.query('INSERT INTO reward_policies(version,hash,canonical,kind) VALUES($1,$2,$3,$4) ON CONFLICT(version) DO NOTHING',[p.version,hashOf(p),stable(p),p.kind]);
 for(const p of [POLICY,TEST_POLICY]){const row=(await db.query('SELECT hash FROM reward_policies WHERE version=$1',[p.version])).rows[0];if(row.hash!==hashOf(p))throw Error('Stored policy '+p.version+' differs from code; create a new policy version');}
 await db.query("INSERT INTO reward_platform(namespace,policy_version) VALUES('production',$1),('mainnet_test',$2) ON CONFLICT DO NOTHING",[POLICY.version,TEST_POLICY.version]);
}
module.exports={POLICY,TEST_POLICY,POLICY_HASH,TEST_POLICY_HASH,POLICIES,policy,hashOf,seed};

// =====================================================================================
// V3 formulas (spec §7, §8, §9). Integers only (BigInt). Units:
//   lamports; raw token units; usd_pico (10^-12 USD); SOL/USD P = usd_pico per 1 SOL;
//   token price Q18 = usd_pico per raw token × 10^18; token/SOL S18 = lamports per raw token × 10^18.
// =====================================================================================
const LAMPORTS=1000000000n,E18=10n**18n,U64=2n**64n-1n;
const big=(x,name='value')=>{
 if(typeof x==='bigint'){if(x<0n)throw Error(name+' must be non-negative');return x;}
 if(typeof x==='number'){if(!Number.isSafeInteger(x)||x<0)throw Error(name+' must be a safe non-negative integer');return BigInt(x);}
 if(typeof x==='string'&&/^\d+$/.test(x))return BigInt(x);
 throw Error(name+' must be an unsigned integer');
};
const u64=(x,name)=>{const n=big(x,name);if(n>U64)throw Error(name+' exceeds u64');return n;};
const ceilDiv=(n,d)=>{if(d<=0n)throw Error('division by zero');return(n+d-1n)/d;};
const sumOf=xs=>xs.reduce((a,b)=>a+big(b),0n);
const HOLD=(reason,extra={})=>({outcome:'hold',reason,...extra});

// §8.1 split once at the funding boundary; carry c ∈ [0,99] persisted per mint.
function splitFunding(gross,carry=0){
 const F=u64(gross,'gross'),c=big(carry,'carry');if(c>99n)throw Error('Invalid split carry');
 const t=85n*F+c,holder=t/100n;return{holder,other:F-holder,carry:t%100n};
}

// §7.2 FIFO proportional consumption. `lots` is the owner's lots in FIFO order (any kind).
// Returns updated lots (new objects) and per-lot movements. Throws if quantity is insufficient
// (caller turns that into a hold: history does not explain the outflow).
function consumeFifo(lots,quantity){
 let left=big(quantity,'quantity');const out=[],moves=[];
 for(const lot of lots){
  const rem=big(lot.remainingQuantity);if(left===0n||rem===0n){out.push(lot);continue;}
  const take=left<rem?left:rem,all=take===rem;
  const part=v=>all?big(v):big(v)*take/rem;
  const m={lotId:lot.id,quantity:take,cost:part(lot.remainingCost),paid:part(lot.paidCredit),reserved:part(lot.reservedCredit)};
  moves.push(m);left-=take;
  out.push({...lot,remainingQuantity:rem-take,remainingCost:big(lot.remainingCost)-m.cost,paidCredit:big(lot.paidCredit)-m.paid,reservedCredit:big(lot.reservedCredit)-m.reserved});
 }
 if(left>0n)throw Object.assign(Error('Outflow exceeds known holdings'),{code:'holding_history_unresolved'});
 return{lots:out,movements:moves};
}

const valueUsd=(quantity,q18)=>ceilDiv(big(quantity)*big(q18),E18);   // value rounds up (conservative)
// USD cost of a purchase: lamports × P / 10^9, rounded down (conservative).
const costUsd=(lamports,solUsdPico)=>big(lamports)*big(solUsdPico)/LAMPORTS;

// §7.3 position of one wallet at the cutoff. lots: that wallet's lots (FIFO order).
// holds: wallet-level evidence problems (never zero-filled).
function position(lots,{priceQ18,holds=[]}){
 if(holds.length)return HOLD(holds[0].reason,{holds});
 if(priceQ18==null)return HOLD('price_unavailable');
 const recognized=lots.filter(l=>l.kind==='purchase'&&big(l.remainingQuantity)>0n);
 const unrecognized=sumOf(lots.filter(l=>l.kind!=='purchase').map(l=>l.remainingQuantity));
 if(lots.some(l=>l.kind==='purchase'&&l.basisPending))return HOLD('basis_pending',{unrecognized});
 const Q=sumOf(recognized.map(l=>l.remainingQuantity)),C=sumOf(recognized.map(l=>l.remainingCost));
 const K=sumOf(recognized.map(l=>big(l.paidCredit)+big(l.reservedCredit)));
 if(Q===0n)return{outcome:'no_recognized_quantity',quantity:0n,cost:0n,value:0n,credit:0n,loss:0n,unrecognized,lots:[]};
 const V=valueUsd(Q,priceQ18),L=C>V+K?C-V-K:0n;
 const lotLosses=recognized.map(l=>{const v=valueUsd(l.remainingQuantity,priceQ18),k=big(l.paidCredit)+big(l.reservedCredit),c=big(l.remainingCost);return{id:l.id,order:l.order,loss:c>v+k?c-v-k:0n};});
 return{outcome:L>0n?'eligible':'no_remaining_loss',quantity:Q,cost:C,value:V,credit:K,loss:L,unrecognized,lots:lotLosses};
}

// §7.3 round allocation. positions: [{owner, loss (usd_pico), ...}] (eligible only are used).
function allocateRound(positions,{holderReserve,solUsdPico}){
 const H=u64(holderReserve,'holderReserve'),P=big(solUsdPico,'solUsdPico');if(P===0n)throw Error('SOL/USD must be positive');
 const eligible=positions.filter(p=>p.outcome==='eligible'&&big(p.loss)>0n).sort((a,b)=>a.owner<b.owner?-1:a.owner>b.owner?1:0);
 if(new Set(eligible.map(p=>p.owner)).size!==eligible.length)throw Error('Duplicate owner in round');
 const S=sumOf(eligible.map(p=>p.loss));
 if(S===0n)return{totalLoss:0n,budget:0n,awards:[],total:0n,undistributed:H};
 const lossLamports=S*LAMPORTS/P,budget=H<lossLamports?H:lossLamports;
 const awards=[];
 for(const p of eligible){
  const L=big(p.loss),cap=L*LAMPORTS/P,pro=budget*L/S,amount=cap<pro?cap:pro;
  if(amount===0n)continue;
  const credit=(()=>{const c=ceilDiv(amount*P,LAMPORTS);return c<L?c:L;})();
  awards.push({owner:p.owner,amount,credit,loss:L,cap});
 }
 const total=sumOf(awards.map(a=>a.amount));
 if(total>H||awards.some(a=>a.amount>a.cap))throw Error('Allocation invariant violated');
 return{totalLoss:S,budget,awards:awards.map((a,index)=>({...a,index})),total,undistributed:H-total};
}

// Attribute a frozen USD credit to the wallet's loss-bearing lots, proportional to each
// lot's own positive loss; remainder to the earliest such lot (deterministic).
function attributeCredit(credit,lotLosses){
 const C=big(credit,'credit');if(C===0n)return[];
 const bearing=lotLosses.filter(l=>big(l.loss)>0n).sort((a,b)=>Number(a.order)-Number(b.order));
 const base=bearing.length?bearing:[...lotLosses].sort((a,b)=>Number(a.order)-Number(b.order)).slice(0,1);
 if(!base.length)throw Error('No lot to attribute credit to');
 const total=sumOf(base.map(l=>l.loss));
 const shares=base.map(l=>({lotId:l.id,credit:total>0n?C*big(l.loss)/total:0n}));
 const rest=C-sumOf(shares.map(s=>s.credit));shares[0].credit+=rest;
 return shares.filter(s=>s.credit>0n);
}

// §9 schedule. All times are UTC unix seconds.
function schedule(anchor,n,{cycleSeconds,cutoffLeadSeconds}){
 const a=big(anchor,'anchor'),k=big(n,'cycle');if(k<1n)throw Error('Cycles start at 1');
 const len=BigInt(cycleSeconds),lead=BigInt(cutoffLeadSeconds);
 const start=a+(k-1n)*len,end=a+k*len;return{cycle:k,start,end,cutoff:end-lead,due:end};
}
// Current cycle number for time t (the cycle containing t); null before the anchor.
function cycleAt(anchor,t,{cycleSeconds}){const a=big(anchor),x=big(t);if(x<a)return null;return(x-a)/BigInt(cycleSeconds)+1n;}

// §7.4 reference price at the cutoff: max(spot, 60 s TWAP), token/USD.
// token: [{time, s18, market, invalidated?, continuityVerified?}] verified market states
//        (token/SOL S18 after each state change or heartbeat sample).
// sol:   [{time, price (usd_pico/SOL), conf}] SOL/USD observations.
// coverage: {complete, throughTime, impliedHeartbeats} — impliedHeartbeats=true only when event
//   coverage for the market is complete through the cutoff, so the state is proven unchanged
//   between observations (it is sampled, not assumed).
function referencePrice({token,sol,cutoff,coverage,policy=POLICY}){
 const T=Number(cutoff),W=policy.priceWindowSeconds,start=T-W,gap=policy.maxObservationGapSeconds,age=policy.maxPriceAgeSeconds;
 if(!coverage?.complete||Number(coverage.throughTime)<T)return HOLD('history_incomplete');
 const tk=[...token].filter(o=>o.time<=T).sort((a,b)=>a.time-b.time||(a.slot||0)-(b.slot||0));
 const lastInvalid=tk.findLastIndex(o=>o.invalidated);const hist=lastInvalid<0?tk:tk.slice(lastInvalid+1);
 const before=hist.filter(o=>o.time<=start).at(-1);if(!before)return HOLD('price_window_incomplete');
 const inWin=hist.filter(o=>o.time>start);
 for(const o of [before,...inWin])if(o.s18==null||big(o.s18)===0n)return HOLD('invalid_reserves');
 let prev=before;for(const o of inWin){if(o.market!==prev.market&&!o.continuityVerified)return HOLD('price_continuity_unverified');prev=o;}
 if(!coverage.impliedHeartbeats){ // explicit samples must satisfy gap/age limits
  let t=start,p=before;for(const o of inWin){if(o.time-Math.max(t,p.time)>gap)return HOLD('price_gap');t=o.time;p=o;}
  if(T-Math.max(p.time,start)>age)return HOLD('price_stale');
 }
 const sx=[...sol].filter(o=>o.time<=T).sort((a,b)=>a.time-b.time);
 const sBefore=sx.filter(o=>o.time<=start).at(-1),sIn=sx.filter(o=>o.time>start);
 if(!sBefore||start-sBefore.time>gap)return HOLD('sol_usd_window_incomplete');
 for(const o of [sBefore,...sIn]){const p=big(o.price),c=big(o.conf||0);if(p===0n)return HOLD('sol_usd_invalid');if(c*10000n>p*BigInt(policy.solUsd.maxConfidenceBps))return HOLD('sol_usd_confidence');}
 {let t=Math.max(sBefore.time,start);for(const o of sIn){if(o.time-t>gap)return HOLD('sol_usd_gap');t=o.time;}if(T-t>policy.solUsd.maxAgeSeconds)return HOLD('sol_usd_stale');}
 // Integrate the product of two step functions over [start, T].
 const points=[...new Set([start,...inWin.map(o=>o.time),...sIn.map(o=>o.time),T])].filter(x=>x>=start&&x<=T).sort((a,b)=>a-b);
 const at=(series,first,t)=>{let v=first;for(const o of series){if(o.time<=t)v=o;else break;}return v;};
 let acc=0n;for(let i=0;i+1<points.length;i++){const t=points[i],dt=BigInt(points[i+1]-t);acc+=big(at(inWin,before,t).s18)*big(at(sIn,sBefore,t).price)*dt;}
 const twap=ceilDiv(acc,BigInt(W)*LAMPORTS),lastT=at(inWin,before,T),lastS=at(sIn,sBefore,T);
 const spot=ceilDiv(big(lastT.s18)*big(lastS.price),LAMPORTS);
 if(twap===0n||spot===0n)return HOLD('invalid_price');
 const hi=spot>twap?spot:twap,lo=spot>twap?twap:spot;
 if(hi*10000n>lo*BigInt(policy.maxSpotTwapRatioBps))return HOLD('price_circuit_breaker');
 return{outcome:'pass',q18:hi,spot,twap,solUsd:big(lastS.price),solUsdTime:lastS.time,tokenTime:lastT.time,cutoff:T};
}
// Pump bonding curve and PumpSwap token/SOL price as S18 (lamports per raw token × 10^18).
const curveS18=({virtualSolReserves,virtualTokenReserves})=>{const q=big(virtualSolReserves),b=big(virtualTokenReserves);if(b===0n||q===0n)return null;return q*E18/b;};
const ammS18=({quoteReserve,baseReserve,virtualQuote=0})=>{const q=big(quoteReserve)+big(virtualQuote),b=big(baseReserve);if(b===0n||q===0n)return null;return q*E18/b;};

// Deterministic canonical hash of any snapshot/manifest object.
const canonicalHash=x=>W.hash(stable(x)).toString('hex');

Object.assign(module.exports,{LAMPORTS,E18,big,u64,ceilDiv,splitFunding,consumeFifo,valueUsd,costUsd,position,allocateRound,attributeCredit,schedule,cycleAt,referencePrice,curveS18,ammS18,canonicalHash});
