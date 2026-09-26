'use strict';
// Spec §19 "Accounting and eligibility" + timing arithmetic for policy rebound-v3.0.
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../../server/rewards/policy-v3.cjs');
const USD=10n**12n,SOL=10n**9n;
const usd=x=>BigInt(Math.round(x*1e6))*10n**6n;           // dollars → usd_pico (exact for ≤ 6 decimals)
const lot=(id,order,{qty,cost,paid=0n,reserved=0n,kind='purchase'})=>({id,order,kind,quantity:qty,remainingQuantity:qty,remainingCost:cost,paidCredit:paid,reservedCredit:reserved});
// price Q18 so that `tokens` raw units are worth `dollars`
const priceFor=(dollars,tokens)=>usd(dollars)*P.E18/BigInt(tokens);

test('policy constants: 85/15, 1800/60 production, 120/30 isolated test policy, SOL loss (v3.1; USD v3.0 kept), no exit bans',()=>{
 assert.equal(P.POLICY.holdersBps+P.POLICY.otherBps,10000);assert.equal(P.POLICY.holdersBps,8500);
 assert.equal(P.POLICY.cycleSeconds,1800);assert.equal(P.POLICY.cutoffLeadSeconds,60);
 assert.equal(P.TEST_POLICY.cycleSeconds,120);assert.equal(P.TEST_POLICY.cutoffLeadSeconds,30);
 assert.equal(P.POLICY.lossUnit,'SOL');assert.equal(P.TEST_POLICY.lossUnit,'SOL');assert.equal(P.POLICY_USD.lossUnit,'USD');assert.equal(P.POLICY.version,'rebound-v3.1');assert.equal(P.TEST_POLICY.version,'rebound-v3.1-test');assert.equal(P.policy('rebound-v3.0').lossUnit,'USD');assert.equal(P.POLICY.maturitySeconds,0);
 assert.equal(P.POLICY.permanentExitOnSale,false);assert.equal(P.POLICY.walletLinkExclusion,false);assert.equal(P.POLICY.pumpHolderRewardMode,false);
 assert.notEqual(P.POLICY_HASH,P.TEST_POLICY_HASH);assert.match(P.POLICY_HASH,/^[a-f0-9]{64}$/);
});

test('$100:$50:$20 losses at $100/SOL split a 0.85 SOL pool into 0.50/0.25/0.10 SOL; next round sees $50/$25/$10',()=>{
 const split=P.splitFunding(SOL,0);assert.equal(split.holder,850000000n);assert.equal(split.other,150000000n);
 const r=P.allocateRound([{owner:'A',outcome:'eligible',loss:usd(100)},{owner:'B',outcome:'eligible',loss:usd(50)},{owner:'C',outcome:'eligible',loss:usd(20)}],{holderReserve:split.holder,solUsdPico:usd(100)});
 assert.deepEqual(r.awards.map(a=>[a.owner,a.amount,a.credit]),[['A',500000000n,usd(50)],['B',250000000n,usd(25)],['C',100000000n,usd(10)]]);
 assert.equal(r.total,850000000n);assert.equal(r.undistributed,0n);
 // Unchanged prices/positions next round: prior credit reduces loss exactly once.
 const pos=(cost,value,credit)=>{const Q=1000000n;return P.position([lot('l',0,{qty:Q,cost:usd(cost),reserved:credit})],{priceQ18:priceFor(value,Q)});};
 assert.equal(pos(200,100,usd(50)).loss,usd(50));assert.equal(pos(100,50,usd(25)).loss,usd(25));assert.equal(pos(40,20,usd(10)).loss,usd(10));
});

test('paid and actively reserved compensation both reduce remaining loss, once',()=>{
 const Q=1000n,price=priceFor(70,Q);
 const base=P.position([lot('a',0,{qty:Q,cost:usd(100)})],{priceQ18:price});assert.equal(base.loss,usd(30));
 assert.equal(P.position([lot('a',0,{qty:Q,cost:usd(100),paid:usd(10)})],{priceQ18:price}).loss,usd(20));
 assert.equal(P.position([lot('a',0,{qty:Q,cost:usd(100),reserved:usd(10)})],{priceQ18:price}).loss,usd(20));
 assert.equal(P.position([lot('a',0,{qty:Q,cost:usd(100),paid:usd(10),reserved:usd(5)})],{priceQ18:price}).loss,usd(15));
 assert.equal(P.position([lot('a',0,{qty:Q,cost:usd(100),paid:usd(40)})],{priceQ18:price}).outcome,'no_remaining_loss');
});

test('no eligible holders, no funds, excess funds, zero-lamport awards and deterministic rounding',()=>{
 assert.deepEqual(P.allocateRound([],{holderReserve:5n,solUsdPico:usd(100)}).awards,[]);
 assert.equal(P.allocateRound([{owner:'A',outcome:'no_remaining_loss',loss:0n}],{holderReserve:5n,solUsdPico:usd(100)}).undistributed,5n);
 assert.equal(P.allocateRound([{owner:'A',outcome:'eligible',loss:usd(10)}],{holderReserve:0n,solUsdPico:usd(100)}).awards.length,0);
 // Excess funds: never more than the loss cap; the rest carries forward.
 const excess=P.allocateRound([{owner:'A',outcome:'eligible',loss:usd(10)}],{holderReserve:10n*SOL,solUsdPico:usd(100)});
 assert.equal(excess.total,100000000n);assert.equal(excess.undistributed,10n*SOL-100000000n);assert.equal(excess.awards[0].credit,usd(10));
 // Tiny loss that rounds to 0 lamports is omitted, never paid as dust.
 const tiny=P.allocateRound([{owner:'A',outcome:'eligible',loss:1n},{owner:'B',outcome:'eligible',loss:usd(1)}],{holderReserve:SOL,solUsdPico:usd(150)});
 assert.deepEqual(tiny.awards.map(a=>a.owner),['B']);
 // Rounding: 3 equal losses, 100 lamports → 33 each, 1 carried.
 const three=P.allocateRound(['X','Y','Z'].map(owner=>({owner,outcome:'eligible',loss:usd(1)})),{holderReserve:100n,solUsdPico:usd(100)});
 assert.deepEqual(three.awards.map(a=>a.amount),[33n,33n,33n]);assert.equal(three.undistributed,1n);
 for(let i=0;i<200;i++){const H=BigInt(1+Math.floor(Math.random()*1e9)),ps=Array.from({length:7},(_,k)=>({owner:'w'+k,outcome:'eligible',loss:BigInt(Math.floor(Math.random()*1e15))}));const r=P.allocateRound(ps,{holderReserve:H,solUsdPico:usd(90+Math.random()*120)});assert.ok(r.total<=H);for(const a of r.awards)assert.ok(a.amount<=a.cap&&a.credit<=a.loss);}
 assert.throws(()=>P.allocateRound([{owner:'A',outcome:'eligible',loss:1n},{owner:'A',outcome:'eligible',loss:1n}],{holderReserve:1n,solUsdPico:1n}),/Duplicate/);
});

test('tiny repeated funding conserves every lamport at exactly 85/15 over time; carried funds are never re-split',()=>{
 let carry=0n,holder=0n,other=0n,gross=0n;
 for(let i=0;i<1000;i++){const F=BigInt(1+(i%7));const s=P.splitFunding(F,carry);holder+=s.holder;other+=s.other;carry=s.carry;gross+=F;assert.equal(s.holder+s.other,F);}
 assert.equal(holder+other,gross);assert.equal(holder,(85n*gross)/100n);   // exact after carries
 assert.throws(()=>P.splitFunding(1n,100n),/carry/);
 // "Split once": the retained/other bucket is not an input to splitFunding again. A second cycle
 // without new gross funding therefore splits nothing: splitFunding is only applied to new F.
 assert.deepEqual(P.splitFunding(0n,carry),{holder:0n,other:0n,carry});
});

test('partial sale consumes FIFO basis and credit proportionally without banning the wallet',()=>{
 const Q=100n,l=lot('a',0,{qty:Q,cost:usd(100),reserved:usd(10)});
 const before=P.position([l],{priceQ18:priceFor(70,Q)});assert.equal(before.loss,usd(20));
 const {lots:after,movements}=P.consumeFifo([l],50n);
 assert.deepEqual([after[0].remainingQuantity,after[0].remainingCost,after[0].reservedCredit],[50n,usd(50),usd(5)]);
 assert.deepEqual([movements[0].quantity,movements[0].cost,movements[0].reserved],[50n,usd(50),usd(5)]);
 const now=P.position(after,{priceQ18:priceFor(70,Q)});assert.equal(now.value,usd(35));assert.equal(now.loss,usd(10));assert.equal(now.outcome,'eligible');
 // FIFO across lots: the oldest lot is consumed first, including zero-basis incoming lots.
 const lots=[lot('gift',0,{qty:30n,cost:0n,kind:'unrecognized_incoming'}),lot('buy1',1,{qty:50n,cost:usd(50)}),lot('buy2',2,{qty:50n,cost:usd(80)})];
 const r=P.consumeFifo(lots,60n);assert.deepEqual(r.lots.map(x=>x.remainingQuantity),[0n,20n,50n]);assert.equal(r.lots[1].remainingCost,usd(20));
 assert.throws(()=>P.consumeFifo(lots,131n),e=>e.code==='holding_history_unresolved');
 // Full sale then new purchase: the old lot is empty, the new proven purchase qualifies.
 const sold=P.consumeFifo([l],100n).lots,again=[...sold,lot('new',1,{qty:10n,cost:usd(10)})];
 assert.equal(P.position(again,{priceQ18:priceFor(5,10n)}).loss,usd(5));
});

test('rounding across fractional proportions never loses cost or credit',()=>{
 let l=lot('a',0,{qty:7n,cost:1000003n,paid:333n,reserved:17n}),moved={cost:0n,paid:0n,reserved:0n};
 for(const q of [1n,2n,3n,1n]){const r=P.consumeFifo([l],q);l=r.lots[0];for(const k of ['cost','paid','reserved'])moved[k]+=r.movements[0][k];}
 assert.equal(l.remainingQuantity,0n);assert.deepEqual([moved.cost,moved.paid,moved.reserved],[1000003n,333n,17n]);
});

test('profitable remaining lots offset losing lots of the same wallet and mint',()=>{
 const price=priceFor(1,1n); // $1 per raw unit
 const losing=lot('l',0,{qty:10n,cost:usd(30)}),winning=lot('w',1,{qty:10n,cost:usd(4)});
 const p=P.position([losing,winning],{priceQ18:price});
 assert.equal(p.cost,usd(34));assert.equal(p.value,usd(20));assert.equal(p.loss,usd(14));   // not $20
 const credit=P.attributeCredit(usd(7),p.lots);assert.deepEqual(credit,[{lotId:'l',credit:usd(7)}]);
 const all=P.position([lot('x',0,{qty:10n,cost:usd(5)}),lot('y',1,{qty:10n,cost:usd(5)})],{priceQ18:price});assert.equal(all.outcome,'no_remaining_loss');
});

test('credit attribution is proportional to lot loss and exact; remainder goes to the earliest lot',()=>{
 const parts=P.attributeCredit(10n,[{id:'b',order:2,loss:1n},{id:'a',order:1,loss:2n},{id:'c',order:3,loss:0n}]);
 assert.deepEqual(parts,[{lotId:'a',credit:7n},{lotId:'b',credit:3n}]);
 assert.equal(parts.reduce((s,p)=>s+p.credit,0n),10n);
});

test('gifts carry no basis: unrecognized quantity contributes neither cost nor value',()=>{
 const p=P.position([lot('g',0,{qty:1000n,cost:0n,kind:'unrecognized_incoming'}),lot('b',1,{qty:10n,cost:usd(10)})],{priceQ18:priceFor(5,10n)});
 assert.equal(p.quantity,10n);assert.equal(p.unrecognized,1000n);assert.equal(p.loss,usd(5));
 assert.equal(P.position([lot('g',0,{qty:1000n,cost:0n,kind:'unrecognized_incoming'})],{priceQ18:1n}).outcome,'no_recognized_quantity');
 assert.equal(P.position([lot('b',0,{qty:1n,cost:1n})],{priceQ18:1n,holds:[{reason:'holding_history_unresolved'}]}).outcome,'hold');
 assert.equal(P.position([lot('b',0,{qty:1n,cost:1n})],{priceQ18:null}).reason,'price_unavailable');
});

test('USD accounting: a SOL/USD move changes the loss even when token/SOL is unchanged',()=>{
 const lamports=SOL,Q=1000n,costAt100=P.costUsd(lamports,usd(100));assert.equal(costAt100,usd(100));
 const tokenSolS18=lamports*P.E18/Q;  // unchanged token/SOL
 const q18At80=tokenSolS18*usd(80)/P.LAMPORTS;const p=P.position([lot('a',0,{qty:Q,cost:costAt100})],{priceQ18:q18At80});
 assert.equal(p.value,usd(80));assert.equal(p.loss,usd(20));
 // Paying the $20 at $80/SOL costs 0.25 SOL; at $100/SOL it would cost 0.2 SOL.
 assert.equal(P.allocateRound([{owner:'a',outcome:'eligible',loss:usd(20)}],{holderReserve:SOL,solUsdPico:usd(80)}).total,250000000n);
});

test('schedule: anchor 12:00:00 → cutoff 12:29:00, payout 12:30:00; next 12:59/13:00; timezone independent',()=>{
 const anchor=Date.UTC(2026,8,26,12,0,0)/1000;
 const c1=P.schedule(anchor,1,P.POLICY),c2=P.schedule(anchor,2,P.POLICY);
 const iso=t=>new Date(Number(t)*1000).toISOString();
 assert.equal(iso(c1.cutoff),'2026-09-26T12:29:00.000Z');assert.equal(iso(c1.due),'2026-09-26T12:30:00.000Z');
 assert.equal(iso(c2.cutoff),'2026-09-26T12:59:00.000Z');assert.equal(iso(c2.due),'2026-09-26T13:00:00.000Z');
 assert.equal(P.cycleAt(anchor,anchor,P.POLICY),1n);assert.equal(P.cycleAt(anchor,anchor+1799,P.POLICY),1n);assert.equal(P.cycleAt(anchor,anchor+1800,P.POLICY),2n);assert.equal(P.cycleAt(anchor,anchor-1,P.POLICY),null);
 const prev=process.env.TZ;process.env.TZ='Europe/Moscow';try{assert.equal(iso(P.schedule(anchor,1,P.POLICY).cutoff),'2026-09-26T12:29:00.000Z');}finally{if(prev===undefined)delete process.env.TZ;else process.env.TZ=prev;}
 const t=P.schedule(anchor,1,P.TEST_POLICY);assert.equal(t.end-t.start,120n);assert.equal(t.due-t.cutoff,30n);
});

test('reference price = max(spot, complete 60 s TWAP); stale, gapped, incomplete or discontinuous evidence holds',()=>{
 const T=1_000_000,S=x=>BigInt(x)*10n**15n,sol=[{time:T-70,price:usd(100),conf:usd(0.1)},{time:T-40,price:usd(100),conf:usd(0.1)},{time:T-10,price:usd(100),conf:usd(0.1)}];
 const token=[{time:T-65,s18:S(10),market:'curve'},{time:T-30,s18:S(20),market:'curve'}];
 const cov={complete:true,throughTime:T,impliedHeartbeats:true};
 const r=P.referencePrice({token,sol,cutoff:T,coverage:cov});
 assert.equal(r.outcome,'pass');assert.equal(r.spot,S(20)*usd(100)/P.LAMPORTS);
 assert.equal(r.twap,(S(10)*30n+S(20)*30n)*usd(100)/(60n*P.LAMPORTS));assert.equal(r.q18,r.spot);   // max
 const falling=[{time:T-65,s18:S(20),market:'curve'},{time:T-5,s18:S(19),market:'curve'}];assert.equal(P.referencePrice({token:falling,sol,cutoff:T,coverage:cov}).q18>S(19)*usd(100)/P.LAMPORTS,true);
 assert.equal(P.referencePrice({token,sol,cutoff:T,coverage:{...cov,complete:false}}).reason,'history_incomplete');
 assert.equal(P.referencePrice({token,sol,cutoff:T,coverage:{...cov,throughTime:T-1}}).reason,'history_incomplete');
 assert.equal(P.referencePrice({token:[{time:T-30,s18:S(1),market:'curve'}],sol,cutoff:T,coverage:cov}).reason,'price_window_incomplete');
 assert.equal(P.referencePrice({token,sol:sol.slice(0,2),cutoff:T,coverage:cov}).reason,'sol_usd_stale');
 assert.equal(P.referencePrice({token,sol:[sol[0],sol[2]],cutoff:T,coverage:cov}).reason,'sol_usd_gap');
 assert.equal(P.referencePrice({token,sol:sol.map(s=>({...s,conf:usd(2)})),cutoff:T,coverage:cov}).reason,'sol_usd_confidence');
 assert.equal(P.referencePrice({token:[token[0],{time:T-30,s18:S(20),market:'pool'}],sol,cutoff:T,coverage:cov}).reason,'price_continuity_unverified');
 assert.equal(P.referencePrice({token:[token[0],{time:T-30,s18:S(20),market:'pool',continuityVerified:true}],sol,cutoff:T,coverage:cov}).outcome,'pass');
 const explicit={...cov,impliedHeartbeats:false};
 assert.equal(P.referencePrice({token,sol,cutoff:T,coverage:explicit}).outcome,'pass');                       // 30 s gap is at the limit
 assert.equal(P.referencePrice({token:[token[0],{time:T-25,s18:S(20),market:'curve'}],sol,cutoff:T,coverage:explicit}).reason,'price_gap'); // 35 s gap
 assert.equal(P.referencePrice({token:[token[0],{time:T-45,s18:S(20),market:'curve'}],sol,cutoff:T,coverage:explicit}).reason,'price_stale'); // last sample 45 s old
 assert.equal(P.referencePrice({token:[token[0],{time:T-5,s18:S(1000),market:'curve'}],sol,cutoff:T,coverage:cov}).reason,'price_circuit_breaker');
 assert.equal(P.referencePrice({token:[...token,{time:T-20,invalidated:true}],sol,cutoff:T,coverage:cov}).reason,'price_window_incomplete');
 // Observations after the cutoff are ignored: the cutoff never slides.
 assert.equal(P.referencePrice({token:[...token,{time:T+5,s18:S(1000),market:'curve'}],sol,cutoff:T,coverage:cov}).q18,r.q18);
 assert.equal(P.curveS18({virtualSolReserves:30n*SOL,virtualTokenReserves:1073000000n*10n**6n}),30n*SOL*P.E18/(1073000000n*10n**6n));
 assert.equal(P.ammS18({quoteReserve:0n,baseReserve:1n}),null);
});
