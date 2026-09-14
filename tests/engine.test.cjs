const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.cjs');
const F = require('../src/fixtures.cjs');
const NOW = 1800000000000;
test('all fixture trades and treasuries use lamports and conserve fees', () => {
  const state = F.create(NOW);
  assert.equal(state.version, 2);
  assert.deepEqual(Object.keys(state.demoBalances), ['SOL']);
  for (const t of state.tokens) {
    assert.equal(t.currency, 'SOL');assert.equal(t.decimals, 9);
    assert.equal(t.treasury.paid, 300000000n);
    assert.ok(E.assertAccounting(t.treasury));
  }
  assert.throws(() => F.token({id:'stable',currency:'USDC'}, NOW), /must use SOL/);
});
test('fee split conserves every lamport including small receipts', () => {
  for (let n=0n;n<1001n;n++) {
    const s=E.splitFees(n);assert.equal(s.holders+s.operations+s.buybacks+s.dust,n);
  }
  assert.deepEqual(E.splitFees(1000000000n),{holders:800000000n,operations:150000000n,buybacks:50000000n,dust:0n});
});
test('purchase matures at 15 minutes, outgoing ends future awards', () => {
  const p=E.newPosition('holder');
  E.purchase(p,{id:'buy',quantity:1000000n,officialCost:2000000000n,at:NOW});
  const ref=at=>({confirmed:true,historyComplete:true,at,priceQ:E.PRICE_SCALE*1000n});
  assert.equal(E.shortfall(p,ref(NOW+899999)).shortfall,0n);
  assert.equal(E.shortfall(p,ref(NOW+900000)).shortfall,1000000000n);
  E.outgoing(p,1n);assert.equal(E.shortfall(p,ref(NOW+900000)).shortfall,0n);
});
test('funding reserves SOL; delayed claim survives a sale and cannot repeat', () => {
  const t=F.create(NOW).tokens[0],p=t.positions[0];
  const r=E.fund(t.treasury,t.positions,F.reference(t,NOW),NOW);
  const award=r.allocations.find(a=>a.wallet===p.wallet).amount;
  assert.throws(()=>E.claim(t.treasury,t.positions,r.id,p.wallet,NOW+599999),/correction wait/);
  E.outgoing(p,1000000n);
  assert.equal(E.claim(t.treasury,t.positions,r.id,p.wallet,NOW+600000),award);
  assert.throws(()=>E.claim(t.treasury,t.positions,r.id,p.wallet,NOW+600000),/No unpaid award/);
  assert.ok(E.assertAccounting(t.treasury));
});
test('guardian cancellation restores funds and funded basis during correction wait',()=>{
  const t=F.create(NOW).tokens[0],available=t.treasury.available,basis=t.positions[0].funded;
  const r=E.fund(t.treasury,t.positions,F.reference(t,NOW),NOW);
  assert.throws(()=>E.cancel(t.treasury,t.positions,r.id,NOW,'other'),/Guardian only/);
  E.cancel(t.treasury,t.positions,r.id,NOW+1);
  assert.equal(t.treasury.available,available);assert.equal(t.positions[0].funded,basis);
});
test('receipt replay is idempotent and conflicting replay fails',()=>{
  const t=E.treasury('t',NOW);E.collect(t,'receipt',100n,NOW);
  assert.equal(E.collect(t,'receipt',100n,NOW).replayed,true);
  assert.equal(t.collected,100n);assert.throws(()=>E.collect(t,'receipt',101n,NOW),/conflict/);
});
test('allocations are proportional, capped, and retain rounding dust',()=>{
  const losses=[{wallet:'a',shortfall:5n},{wallet:'b',shortfall:2n}];
  assert.equal(E.allocate(100n,losses).distributed,7n);
  const a=E.allocate(5n,losses);assert.equal(a.distributed+a.dust,5n);
  assert.deepEqual(a.allocations.map(x=>x.amount),[3n,1n]);
});
test('price reference uses higher spot or complete time-weighted average',()=>{
  const r=E.checkedReference({samples:[{at:NOW-900000,priceQ:200n},{at:NOW,priceQ:100n}],spotQ:100n,at:NOW,confirmed:true,historyComplete:true});
  assert.equal(r.priceQ,200n);
  assert.throws(()=>E.twap([{at:NOW-1,priceQ:100n},{at:NOW,priceQ:100n}],NOW),/complete/);
});
test('buyback time gates start at scheduling and never imply execution',()=>{
  assert.equal(E.buybackStatus({},NOW).ready,false);
  const config={configuredAt:NOW,scheduledAt:NOW+1000};
  assert.equal(E.buybackStatus(config,NOW+172800000).ready,false);
  assert.equal(E.buybackStatus(config,NOW+172801000).reason,'execution-checks-required');
  assert.equal(E.buybackStatus({...config,paused:true},NOW+172801000).ready,false);
});
test('amounts reject extra decimals and exponent notation, persist without precision loss',()=>{
  assert.equal(E.parseUnits('1.000000001'),1000000001n);
  for(const s of ['1e9','-1','0.0000000001'])assert.throws(()=>E.parseUnits(s));
  const s=F.create(NOW);assert.deepEqual(E.parse(E.stringify(s)),s);
});
