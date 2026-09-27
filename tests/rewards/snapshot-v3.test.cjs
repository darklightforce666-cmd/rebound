'use strict';
// Snapshot + round proposal from finalized events (spec §7, §9, §19 timing).
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../../server/rewards/snapshot-v3.cjs'),P3=require('../../server/rewards/policy-v3.cjs');
const {chain,SOL,CURVE}=require('./chain-fixture.cjs');
const USD=10n**12n,excluded=new Set([CURVE]);
const fx=()=>({price:100n*USD,conf:0n,time:0,source:'test'});
// Buys at a high price, then the price falls 10x before the cutoff.
function scenario(){
 const c=chain({startSlot:100,timeOf:s=>10000+(s-100)*10});           // 10 s per slot in this fixture
 const hi={vSol:300n*SOL,vTok:10n**12n},lo={vSol:30n*SOL,vTok:10n**12n};
 c.tx(x=>x.buy('Alice','a1',1000000n,{lamports:4n*SOL,...hi}));       // slot 101 t=10010
 c.tx(x=>x.buy('Bob','b1',1000000n,{lamports:2n*SOL,...hi}));         // slot 102 t=10020
 c.tx(x=>x.buy('Carol','c1',1000000n,{lamports:SOL,...hi}));          // slot 103 t=10030
 c.tx(x=>x.buy('Dave','d1',10n**9n,{lamports:1000000n,...lo}));        // slot 104 t=10040 price now low; Dave profitable later
 c.tx(x=>x.sell('Carol','c1',500000n,lo));                             // slot 105 t=10050 partial sale
 return c;
}
const sol=cutoff=>[{time:cutoff-70,price:100n*USD,conf:0n},{time:cutoff-40,price:100n*USD,conf:0n},{time:cutoff-10,price:100n*USD,conf:0n}];
// The USD cases pin the v3.0 (USD) policy; SOL-unit cases (v3.1, current) are at the end of this file.
const args=(c,over={})=>({mint:'M',cycle:1,cutoff:10200,cutoffSlot:120,events:c.events,coverage:{complete:true,throughSlot:130},excluded,fx,solSeries:sol(10200),holderReserve:SOL,policy:P3.POLICY_USD,...over});

test('snapshot allocates the holder reserve in proportion to remaining USD loss, deterministically',()=>{
 const c=scenario(),s=S.build(args(c));
 assert.equal(s.state,'ready');
 const by=Object.fromEntries(s.positions.map(p=>[p.owner,p]));
 assert.equal(by.Dave.outcome,'no_remaining_loss');assert.equal(by.Carol.quantity,'500000');
 const L=o=>BigInt(by[o].lossUsd);assert.ok(L('Alice')>L('Bob')&&L('Bob')>L('Carol'));
 const total=s.awards.reduce((x,a)=>x+BigInt(a.lamports),0n);assert.equal(BigInt(s.total),total);assert.ok(total<=SOL);
 const a=Object.fromEntries(s.awards.map(x=>[x.owner,BigInt(x.lamports)]));
 const S_=L('Alice')+L('Bob')+L('Carol');assert.equal(a.Alice,BigInt(s.budget)*L('Alice')/S_);
 assert.equal(S.build(args(c)).snapshotHash,s.snapshotHash);
 for(const aw of s.awards)assert.equal(aw.lotCredits.reduce((x,l)=>x+BigInt(l.creditUsd),0n),BigInt(aw.creditUsd));
});

test('transactions after the cutoff slot never enter the snapshot; the cutoff does not slide',()=>{
 const c=scenario(),base=S.build(args(c));
 c.skipTo(150).tx(x=>x.sell('Alice','a1',1000000n));                      // slot 150 > cutoff slot 120
 const later=S.build(args(c,{coverage:{complete:true,throughSlot:200}}));
 assert.equal(later.snapshotHash,base.snapshotHash);
});

test('missing evidence waits instead of inventing data',()=>{
 const c=scenario();
 assert.equal(S.build(args(c,{coverage:{complete:false,throughSlot:130}})).reason,'history_incomplete');
 assert.equal(S.build(args(c,{coverage:{complete:true,throughSlot:110}})).reason,'history_behind_cutoff');
 assert.equal(S.build(args(c,{solSeries:[]})).reason,'sol_usd_window_incomplete');
 assert.equal(S.build(args(c,{cutoffSlot:null})).reason,'cutoff_slot_unproven');
 const noFx=S.build(args(c,{fx:()=>null}));assert.equal(noFx.state,'skipped_no_eligible_holders');
 assert.ok(noFx.positions.every(p=>['hold','no_remaining_loss','no_recognized_quantity'].includes(p.outcome)));
 assert.equal(noFx.positions.find(p=>p.owner==='Alice').reason,'basis_pending');
 for(const w of [S.build(args(c,{solSeries:[]}))])assert.deepEqual(w.awards,[]);
});

test('no funds and excess funds: capped by losses, remainder carried',()=>{
 const c=scenario();
 const none=S.build(args(c,{holderReserve:0n}));assert.equal(none.state,'skipped_no_funds');assert.deepEqual(none.awards,[]);
 const lots=S.build(args(c,{holderReserve:1000n*SOL}));
 assert.equal(BigInt(lots.total),lots.awards.reduce((x,a)=>x+BigInt(a.lamports),0n));assert.ok(BigInt(lots.undistributed)>0n);
 for(const a of lots.awards)assert.ok(BigInt(a.creditUsd)<=BigInt(a.lossUsd));
});

test('funded award credits reduce the next round; a later sale does not change the frozen award',()=>{
 const c=scenario(),first=S.build(args(c));
 const credits=first.awards.flatMap(a=>a.lotCredits.map(l=>({slot:120,lotId:l.lotId,credit:BigInt(l.creditUsd),state:'reserved',award:'1:'+a.index})));
 const second=S.build(args(c,{cycle:2,cutoff:10300,cutoffSlot:125,solSeries:sol(10300),credits}));
 const loss=(s,o)=>BigInt(s.positions.find(p=>p.owner===o).lossUsd);
 for(const o of ['Alice','Bob','Carol'])assert.equal(loss(second,o),loss(first,o)-BigInt(first.awards.find(a=>a.owner===o).creditUsd));
 c.skipTo(160).tx(x=>x.sell('Bob','b1',1000000n));    // Bob exits after the first snapshot
 assert.equal(S.build(args(c)).snapshotHash,first.snapshotHash);          // frozen award unchanged
});

test('SOL-unit policy (v3.1): no SOL/USD feed needed; loss and awards in lamports; everyone underwater is paid pro rata, never above their loss',()=>{
 const c=scenario(),noFx=()=>null;
 const s=S.build(args(c,{policy:P3.POLICY_V31,fx:noFx,solSeries:[]}));
 assert.equal(s.lossUnit,'SOL');assert.equal(s.state,'ready');assert.ok(s.awards.length>0);
 const losses=Object.fromEntries(s.positions.filter(p=>p.outcome==='eligible').map(p=>[p.owner,BigInt(p.lossUsd)]));
 for(const a of s.awards){assert.ok(BigInt(a.lamports)<=losses[a.owner],'award above SOL loss');assert.equal(a.creditUsd,a.lamports,'credit is the SOL paid');}
 assert.ok(BigInt(s.total)<=SOL);
 // Plenty of funds: every underwater holder is made whole exactly (award == remaining SOL loss) and the rest is carried.
 const rich=S.build(args(c,{policy:P3.POLICY_V31,fx:noFx,solSeries:[],holderReserve:1000n*SOL}));
 assert.deepEqual(rich.awards.map(a=>[a.owner,BigInt(a.lamports)]).sort(),Object.entries(losses).filter(([,l])=>l>0n).sort());
 assert.equal(BigInt(rich.undistributed),1000n*SOL-BigInt(rich.total));
 // Same inputs → same snapshot; a different unit → a different policy hash.
 assert.equal(S.build(args(c,{policy:P3.POLICY_V31,fx:noFx,solSeries:[]})).snapshotHash,s.snapshotHash);
 assert.notEqual(P3.hashOf(P3.POLICY_V31),P3.hashOf(P3.POLICY_USD));
});
