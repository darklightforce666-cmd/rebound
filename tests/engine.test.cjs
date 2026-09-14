const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../src/engine.cjs'),F=require('../src/fixtures.cjs');
const NOW=1800000000000;
test('one SOL allocates exactly 85% to holders and 15% to operations',()=>{
  assert.deepEqual(E.splitFees(1000000000n),{holders:850000000n,operations:150000000n,dust:0n});
});
test('small receipts preserve every lamport across rounding',()=>{
  for(let n=0n;n<=10000n;n++){const a=E.splitFees(n);assert.equal(a.holders+a.operations+a.dust,n);assert.ok(a.holders*100n<=n*85n);assert.ok(a.operations*100n<=n*15n);assert.ok(a.dust<=1n);}
});
test('fixtures use SOL and the new holder policy',()=>{
  const s=F.create(NOW);assert.equal(s.version,4);assert.deepEqual(Object.keys(s.demoBalances),['SOL']);
  for(const t of s.tokens){assert.equal(t.currency,'SOL');assert.equal(t.mode,'holder-recovery/v2');assert.equal(t.decimals,9);assert.ok(E.assertAccounting(t.treasury));}
  const t=s.tokens[0].treasury;assert.equal(t.collected,1875000000n);assert.equal(t.paid,318750000n);assert.equal(t.operations,281250000n);assert.equal(t.available,1275000000n);
  assert.throws(()=>F.token({id:'stable',currency:'USDC'},NOW),/must use SOL/);
});
test('receipt replay is idempotent and conflicting replay fails',()=>{
  const t=E.treasury('t',NOW);E.collect(t,'fee',1000n,NOW);assert.equal(E.collect(t,'fee',1000n,NOW).replayed,true);assert.equal(t.available,850n);assert.throws(()=>E.collect(t,'fee',1001n,NOW),/conflict/);
});
test('recognized purchase matures at fifteen minutes',()=>{
  const p=E.newPosition('holder');E.purchase(p,{id:'buy',quantity:1000000n,officialCost:2000000000n,at:NOW});const ref=at=>({confirmed:true,historyComplete:true,at,priceQ:E.PRICE_SCALE*1000n});
  assert.equal(E.shortfall(p,ref(NOW+899999)).shortfall,0n);assert.equal(E.shortfall(p,ref(NOW+900000)).shortfall,1000000000n);E.outgoing(p,1n);assert.equal(E.shortfall(p,ref(NOW+900000)).shortfall,0n);
});
test('funded claims wait ten minutes, survive sales, and cannot repeat',()=>{
  const t=F.create(NOW).tokens[0],p=t.positions[0],r=E.fund(t.treasury,t.positions,F.reference(t,NOW),NOW),award=r.allocations.find(a=>a.wallet===p.wallet).amount;
  assert.throws(()=>E.claim(t.treasury,t.positions,r.id,p.wallet,NOW+599999),/correction wait/);E.outgoing(p,1000000n);
  assert.equal(E.claim(t.treasury,t.positions,r.id,p.wallet,NOW+600000),award);assert.throws(()=>E.claim(t.treasury,t.positions,r.id,p.wallet,NOW+600000),/No unpaid/);assert.ok(E.assertAccounting(t.treasury));
});
test('guardian cancellation restores reserved funds and funded basis',()=>{
  const t=F.create(NOW).tokens[0],balance=t.treasury.available,basis=t.positions[0].funded,r=E.fund(t.treasury,t.positions,F.reference(t,NOW),NOW);
  assert.throws(()=>E.cancel(t.treasury,t.positions,r.id,NOW,'other'),/Guardian/);E.cancel(t.treasury,t.positions,r.id,NOW+1);assert.equal(t.treasury.available,balance);assert.equal(t.positions[0].funded,basis);
});
test('awards are capped at remaining shortfall and retain rounding dust',()=>{
  const l=[{wallet:'a',shortfall:5n},{wallet:'b',shortfall:2n}];assert.equal(E.allocate(100n,l).distributed,7n);const a=E.allocate(5n,l);assert.equal(a.distributed+a.dust,5n);assert.deepEqual(a.allocations.map(x=>x.amount),[3n,1n]);
});
test('price references require complete history and use higher spot or average',()=>{
  assert.equal(E.checkedReference({samples:[{at:NOW-900000,priceQ:200n},{at:NOW,priceQ:100n}],spotQ:100n,at:NOW,confirmed:true,historyComplete:true}).priceQ,200n);assert.throws(()=>E.twap([{at:NOW-1,priceQ:100n},{at:NOW,priceQ:100n}],NOW),/complete/);
});
test('invalid amounts and old policies fail while precise state round-trips',()=>{
  for(const a of ['1e9','-1','0.0000000001'])assert.throws(()=>E.parseUnits(a));assert.equal(E.parseUnits('1.000000001'),1000000001n);const s=F.create(NOW);assert.deepEqual(E.parse(E.stringify(s)),s);assert.throws(()=>E.assertAccounting({...s.tokens[0].treasury,policyId:'retired'}),/policy/);
});
