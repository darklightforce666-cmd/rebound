'use strict';
// Spec §19: gifts, same-owner moves, transfers out/back, multiple accounts, delegated movements,
// unknown routes, one transaction with several events, balance proofs and credit replay.
const test=require('node:test'),assert=require('node:assert/strict');
const L=require('../../server/rewards/lots-v3.cjs'),P3=require('../../server/rewards/policy-v3.cjs');
const USD=10n**12n,SOL=10n**9n,CURVE='CurvePDA',FX=()=>({price:100n*USD,conf:0n,time:0,source:'test'});
const excluded=new Set([CURVE,'PoolPDA']);

const {chain}=require('./chain-fixture.cjs');
const run=(events,opts={})=>L.replay(events,{excluded,fx:FX,...opts});
const qty=(r,o)=>r.owners.get(o).lots.reduce((s,l)=>s+l.remainingQuantity,0n);

test('supported purchase creates a proven USD-cost lot; balance proof passes',()=>{
 const c=chain();c.tx(x=>x.buy('A','a1',1000n));const r=run(c.events);
 const [lot]=r.owners.get('A').lots;assert.equal(lot.kind,'purchase');assert.equal(lot.costLamports,SOL+15000000n);assert.equal(lot.cost,P3.costUsd(SOL+15000000n,100n*USD));
 assert.deepEqual(r.owners.get('A').holds,[]);assert.equal(r.observations.length,1);
});

test('partial sale then rebuy: FIFO consumption, no ban, balances proven',()=>{
 const c=chain();c.tx(x=>x.buy('A','a1',1000n));c.tx(x=>x.sell('A','a1',400n));c.tx(x=>x.buy('A','a1',500n));
 const r=run(c.events),lots=r.owners.get('A').lots;
 assert.deepEqual(lots.map(l=>l.remainingQuantity),[600n,500n]);assert.deepEqual(r.owners.get('A').holds,[]);
 assert.equal(r.movements.length,1);assert.equal(r.movements[0].quantity,400n);
});

test('gifts carry no basis; transfer out and back cannot reset basis or credit',()=>{
 const c=chain();c.tx(x=>x.buy('A','a1',1000n));
 const lotId=c.events.find(e=>e.kind==='purchase_candidate').id;
 c.tx(x=>x.transfer('A','a1','B','b1',1000n));c.tx(x=>x.transfer('B','b1','A','a1',1000n));
 const credits=[{slot:101,lotId,credit:10n*USD,state:'reserved',award:'c1'}];
 const r=run(c.events,{credits}),a=r.owners.get('A');
 assert.equal(a.lots.find(l=>l.kind==='purchase').remainingQuantity,0n);
 assert.equal(a.lots.find(l=>l.kind==='purchase').reservedCredit,0n);   // credit left with the tokens
 assert.equal(a.lots.find(l=>l.kind==='unrecognized_incoming').remainingQuantity,1000n);
 const pos=P3.position(a.lots,{priceQ18:1n});assert.equal(pos.outcome,'no_recognized_quantity');assert.equal(pos.unrecognized,1000n);
 assert.equal(qty(r,'B'),0n);assert.deepEqual(r.owners.get('B').holds,[]);
});

test('same-owner moves and multiple token accounts preserve lots; delegated transfers debit the token owner',()=>{
 const c=chain();c.tx(x=>x.buy('A','a1',1000n));c.tx(x=>x.transfer('A','a1','A','a2',300n));
 let r=run(c.events);assert.equal(r.owners.get('A').lots.length,1);assert.equal(qty(r,'A'),1000n);assert.deepEqual(r.owners.get('A').holds,[]);
 c.tx(x=>x.transfer('A','a2','D','d1',100n,{delegate:'SomeDelegate'}));r=run(c.events);
 assert.equal(qty(r,'A'),900n);assert.equal(r.owners.has('SomeDelegate'),false);assert.equal(r.owners.get('A').lots[0].remainingQuantity,900n);
});

test('buyer who is not the recipient gets nothing; recipient is unrecognized; side pools are unrecognized',()=>{
 const c=chain();c.tx(x=>x.buy('Payer','r1',50n,{recipientOwner:'Recipient'}));c.tx(x=>x.buy('S','s1',70n,{venue:'side-pool'}));
 const r=run(c.events);
 assert.equal(r.owners.has('Payer'),false);
 assert.equal(r.owners.get('Recipient').lots[0].kind,'unrecognized_incoming');assert.equal(r.owners.get('Recipient').lots[0].reason,'buyer_is_not_recipient');
 assert.equal(r.owners.get('S').lots[0].kind,'unrecognized_incoming');
});

test('unproven payment, missing FX and missing delivery hold explicitly (never zero-filled)',()=>{
 const c=chain();c.tx(x=>x.buy('A','a1',10n,{pay:1n}));const r=run(c.events);
 assert.equal(r.owners.get('A').holds[0].reason,'purchase_amounts_unproven');assert.equal(P3.position(r.owners.get('A').lots,{priceQ18:1n,holds:r.owners.get('A').holds}).outcome,'hold');
 const f=chain();f.tx(x=>x.buy('A','a1',10n));const rf=L.replay(f.events,{excluded,fx:()=>null});
 assert.equal(P3.position(rf.owners.get('A').lots,{priceQ18:1n}).reason,'basis_pending');
 const m=chain();m.tx(x=>x.buy('A','a1',10n));const noDelivery=m.events.filter(e=>e.kind!=='market_delivery');
 assert.ok(run(noDelivery).owners.get('A').holds.some(h=>h.reason==='purchase_delivery_unproven'));
});

test('reconstructed holdings that disagree with real balances are held',()=>{
 const c=chain();c.tx(x=>x.buy('A','a1',1000n));
 const tampered=c.events.map(e=>e.kind==='token_balances'?{...e,data:{accounts:[{account:'a1',owner:'A',amount:'999'}]}}:e);
 assert.equal(run(tampered).owners.get('A').holds[0].reason,'holding_balance_mismatch');
 const over=chain();over.tx(x=>x.buy('A','a1',10n));over.tx(x=>x.burn('A','a1',10n));
 const bad=over.events.map(e=>e.kind==='burn'?{...e,data:{...e.data,amount:'11'}}:e);
 assert.ok(run(bad).owners.get('A').holds.some(h=>h.reason==='holding_history_unresolved'));
});

test('one transaction with several purchases is indexed once per event',()=>{
 const c=chain();c.tx(x=>{x.buy('A','a1',10n);x.buy('B','b1',20n);x.buy('A','a1',30n);});
 const r=run(c.events);assert.deepEqual(r.owners.get('A').lots.map(l=>l.quantity),[10n,30n]);assert.deepEqual(r.owners.get('B').lots.map(l=>l.quantity),[20n]);
 assert.equal(new Set(c.events.map(e=>e.id)).size,c.events.length);
});

test('credits replay at their snapshot slot: later partial sale removes credit proportionally; later events do not enter a snapshot',()=>{
 const c=chain();c.tx(x=>x.buy('A','a1',100n));const lotId=c.events.find(e=>e.kind==='purchase_candidate').id;
 const snapshotSlot=c.events.at(-1).slot;c.tx(x=>x.sell('A','a1',50n));
 const credits=[{slot:snapshotSlot,lotId,credit:10n*USD,state:'paid',award:'c1'}];
 const r=run(c.events,{credits});assert.equal(r.owners.get('A').lots[0].paidCredit,5n*USD);
 const before=run(c.events,{credits,throughSlot:snapshotSlot});assert.equal(before.owners.get('A').lots[0].remainingQuantity,100n);assert.equal(before.owners.get('A').lots[0].paidCredit,10n*USD);
 const missing=run(c.events,{credits:[{slot:snapshotSlot,lotId:'nope',credit:1n,state:'paid'}]});assert.equal(missing.mintHolds[0].reason,'credit_lot_missing');
});
