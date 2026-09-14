/* REBOUND reference ledger. Local simulation only; not an on-chain program.
 * All financial arithmetic is integer-only. Price = quote atomic units per token
 * atomic unit, scaled by PRICE_SCALE. See docs/PARITY.md for port assumptions. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReboundEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PRICE_SCALE = 1_000_000_000_000n;
  const POLICY = Object.freeze({id:'holder-recovery/v2', holdMs:900_000, roundDelayMs:600_000,
    correctionMs:43_200_000, roleDelayMs:86_400_000, activationMs:172_800_000,
    dormantMs:7_776_000_000, activeSweepMs:900_000, idleSweepMs:21_600_000,
    minTaxBps:10, maxTaxBps:1000, defaultTaxBps:500});
  function invariant(ok, message) { if (!ok) throw new Error(message); }
  function natural(value, name='amount') {
    invariant(typeof value === 'bigint' && value >= 0n, name+' must be a nonnegative BigInt');
    return value;
  }
  function timestamp(v) { invariant(Number.isSafeInteger(v) && v >= 0, 'Invalid timestamp'); return v; }
  function parseUnits(text, decimals=9) {
    invariant(Number.isInteger(decimals) && decimals>=0 && decimals<=18, 'Invalid decimals');
    invariant(typeof text==='string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(text), 'Enter a positive decimal number, without commas or exponent notation');
    const [whole, fraction=''] = text.split('.');
    invariant(fraction.length<=decimals, `Maximum ${decimals} decimal places`);
    invariant(whole.length<=50, 'Amount is too large');
    return BigInt(whole)*10n**BigInt(decimals) + BigInt(fraction.padEnd(decimals,'0') || '0');
  }
  function formatUnits(value, decimals=9, precision=decimals) {
    natural(value); invariant(Number.isInteger(decimals)&&decimals>=0&&decimals<=18,'Invalid decimals');
    invariant(Number.isInteger(precision)&&precision>=0&&precision<=decimals,'Invalid precision');
    const scale=10n**BigInt(decimals), whole=(value/scale).toString();
    if(!precision) return whole;
    const fraction=(value%scale).toString().padStart(decimals,'0').slice(0,precision).replace(/0+$/,'');
    return whole+(fraction?'.'+fraction:'');
  }
  function validateTax(bps) { invariant(Number.isInteger(bps)&&bps>=10&&bps<=1000,'Creator tax must be 10-1,000 basis points'); return bps; }
  function splitFees(received) {
    natural(received); const holders=received*8500n/10000n, operations=received*1500n/10000n;
    return {holders, operations, dust:received-holders-operations};
  }
  function newPosition(wallet) {
    invariant(typeof wallet==='string'&&wallet.length>0,'Wallet required');
    return {wallet,lots:[],unrecognized:0n,hasOutgoing:false,funded:0n,paid:0n,activityIds:[]};
  }
  function purchase(p, {id,quantity,officialCost,at}) {
    natural(quantity); natural(officialCost); timestamp(at);
    invariant(quantity>0n && typeof id==='string' && id.length>0,'Invalid purchase');
    invariant(!p.activityIds.includes(id),'Duplicate activity');
    p.lots.push({id,quantity,cost:officialCost,at}); p.activityIds.push(id);
    // Entire received quantity is recognized; only official-venue cost is basis.
    return p;
  }
  function incoming(p,quantity) {natural(quantity); p.unrecognized+=quantity; return p;}
  function outgoing(p,quantity) {
    natural(quantity); invariant(quantity>0n,'Outgoing quantity must be positive');
    const balance=p.lots.reduce((s,l)=>s+l.quantity,0n)+p.unrecognized;
    invariant(quantity<=balance,'Insufficient token balance');
    p.hasOutgoing=true;
    let remainder=quantity, fromUnrecognized=remainder<p.unrecognized?remainder:p.unrecognized;
    p.unrecognized-=fromUnrecognized; remainder-=fromUnrecognized;
    for(const lot of p.lots) {
      if(!remainder) break;
      const removed=remainder<lot.quantity?remainder:lot.quantity;
      const oldQuantity=lot.quantity;
      lot.quantity-=removed;
      lot.cost=oldQuantity ? lot.cost*lot.quantity/oldQuantity : 0n;
      remainder-=removed;
    }
    return p;
  }
  function twap(samples, now, windowMs=POLICY.holdMs) {
    timestamp(now); invariant(Number.isSafeInteger(windowMs)&&windowMs>0,'Invalid price window');
    invariant(Array.isArray(samples)&&samples.length>=2,'Incomplete price history');
    const start=now-windowMs;
    invariant(start>=0,'Incomplete price history');
    let previous=-1;
    for(const s of samples) {
      timestamp(s.at); natural(s.priceQ,'price');
      invariant(s.priceQ>0n && s.at>previous && s.at<=now,'Invalid price history'); previous=s.at;
    }
    invariant(samples[0].at<=start && samples.at(-1).at===now,'A complete 15-minute price reference is required');
    let sum=0n;
    for(let i=0;i<samples.length-1;i++) {
      const from=Math.max(start,samples[i].at), to=Math.min(now,samples[i+1].at);
      if(to>from) sum+=samples[i].priceQ*BigInt(to-from);
    }
    return sum/BigInt(windowMs);
  }
  function checkedReference({samples,spotQ,at,confirmed,historyComplete}) {
    invariant(confirmed===true,'Snapshot is not confirmed');
    invariant(historyComplete===true,'Indexed history is incomplete');
    natural(spotQ,'spot price'); invariant(spotQ>0n,'Invalid spot price');
    const averageQ=twap(samples,at);
    return {at,confirmed:true,historyComplete:true,spotQ,averageQ,priceQ:spotQ>averageQ?spotQ:averageQ};
  }
  function shortfall(p,reference,now=reference.at) {
    timestamp(now); invariant(reference.confirmed===true&&reference.historyComplete===true,'Unverified reference');
    natural(reference.priceQ,'reference price'); invariant(reference.priceQ>0n,'Invalid reference price');
    invariant(reference.at<=now,'Future reference');
    const mature=p.lots.filter(l=>l.at+POLICY.holdMs<=reference.at);
    const quantity=mature.reduce((s,l)=>s+l.quantity,0n), cost=mature.reduce((s,l)=>s+l.cost,0n);
    const value=quantity*reference.priceQ/PRICE_SCALE;
    const raw=cost-value-p.funded;
    return {wallet:p.wallet,eligible:!p.hasOutgoing&&cost>0n&&raw>0n,
      reason:p.hasOutgoing?'outgoing':cost===0n?(p.lots.length?'holding-period':'unrecognized-entry'):raw<=0n?'covered':'eligible',
      quantity,cost,value,previousFunded:p.funded,shortfall:p.hasOutgoing||raw<=0n?0n:raw};
  }
  function allocate(available,losses) {
    natural(available); const seen=new Set();
    for(const l of losses) {natural(l.shortfall); invariant(typeof l.wallet==='string'&&!seen.has(l.wallet),'Duplicate wallet'); seen.add(l.wallet);}
    const total=losses.reduce((s,l)=>s+l.shortfall,0n), budget=available<total?available:total;
    const allocations=losses.map((l,index)=>({wallet:l.wallet,index,amount:total?budget*l.shortfall/total:0n})).filter(a=>a.amount>0n);
    const distributed=allocations.reduce((s,a)=>s+a.amount,0n);
    return {total,budget,distributed,dust:budget-distributed,allocations};
  }
  function treasury(id,createdAt,generation=4) {
    timestamp(createdAt); invariant(generation===3||generation===4,'Unsupported generation');
    return {id,policyId:POLICY.id,generation,createdAt,repairDeadline:createdAt+POLICY.correctionMs,lastActivity:createdAt,
      available:0n,reserved:0n,paid:0n,funded:0n,collected:0n,operations:0n,feeDust:0n,recovered:0n,
      collections:[],rounds:[],roles:{publisher:'demo-publisher',operations:'demo-operations',guardian:'demo-guardian'},pendingRoles:{}};
  }
  function collect(t, eventId, amount, now) {
    natural(amount); timestamp(now); invariant(now>=t.createdAt,'Collection precedes treasury creation');
    invariant(typeof eventId==='string'&&eventId.length>0,'Collection evidence ID required');
    const existing=t.collections.find(e=>e.id===eventId);
    if(existing) {invariant(existing.amount===amount,'Idempotency conflict'); return {replayed:true,...existing.split};}
    const split=splitFees(amount);
    t.available+=split.holders;t.operations+=split.operations;t.feeDust+=split.dust;t.collected+=amount;
    if(amount>0n) t.lastActivity=now;
    t.collections.push({id:eventId,amount,at:now,split});
    assertAccounting(t); return {replayed:false,...split};
  }
  function fund(t,positions,reference,now) {
    timestamp(now); invariant(reference.at<=now&&now-reference.at<=120000,'Stale or future snapshot');
    invariant(!t.rounds.some(r=>!r.cancelled&&now<r.claimableAt),'A round is still in its correction wait');
    const result=allocate(t.available,positions.map(p=>shortfall(p,reference,now)));
    invariant(result.distributed>0n,'No funded awards: check eligible losses, holding time and treasury funds');
    const id=t.rounds.length+1;
    const round={id,policyId:POLICY.id,snapshotAt:reference.at,referenceQ:reference.priceQ,
      fundedAt:now,claimableAt:now+(t.generation===4?POLICY.roundDelayMs:0),amount:result.distributed,cancelled:false,
      allocations:result.allocations.map(a=>({...a,paid:false,paidAt:null,transactionSignature:null}))};
    t.available-=result.distributed;t.reserved+=result.distributed;t.funded+=result.distributed;t.lastActivity=now;t.rounds.push(round);
    for(const a of round.allocations) positions.find(p=>p.wallet===a.wallet).funded+=a.amount;
    assertAccounting(t); return round;
  }
  function claim(t,positions,roundId,wallet,now) {
    timestamp(now); const r=t.rounds.find(r=>r.id===roundId);
    invariant(r&&!r.cancelled,'Round unavailable');invariant(now>=r.claimableAt,'Round has a 10-minute correction wait');
    const a=r.allocations.find(a=>a.wallet===wallet); invariant(a&&!a.paid,'No unpaid award for this wallet');
    const p=positions.find(p=>p.wallet===wallet); invariant(p,'Position ledger missing');
    // Eligibility is not re-evaluated here: later sales cannot erase funded claims.
    a.paid=true;a.paidAt=now;t.reserved-=a.amount;t.paid+=a.amount;p.paid+=a.amount;
    assertAccounting(t);return a.amount;
  }
  function cancel(t,positions,roundId,now,actor='demo-guardian') {
    timestamp(now);invariant(actor===t.roles.guardian,'Guardian only');
    const r=t.rounds.find(r=>r.id===roundId); invariant(r&&!r.cancelled,'Round unavailable');
    invariant(now>=r.fundedAt && now<r.claimableAt&&!r.allocations.some(a=>a.paid),'Correction wait has closed');
    for(const a of r.allocations) invariant(positions.some(p=>p.wallet===a.wallet&&p.funded>=a.amount),'Position ledger missing');
    r.cancelled=true;t.reserved-=r.amount;t.available+=r.amount;t.funded-=r.amount;
    for(const a of r.allocations) positions.find(p=>p.wallet===a.wallet).funded-=a.amount;
    assertAccounting(t);return r.amount;
  }
  function recoverUnallocated(t,amount,now) {
    natural(amount);timestamp(now);invariant(now>=t.createdAt&&now<t.repairDeadline,'Treasury correction window has closed');
    invariant(amount<=t.available,'Funded claims are protected');t.available-=amount;t.recovered+=amount;assertAccounting(t);return amount;
  }
  function queueRole(t,role,address,now) {
    timestamp(now);invariant(['publisher','operations','guardian'].includes(role),'Unsupported role');
    invariant(typeof address==='string'&&address.length>0,'Address required');
    if(role==='guardian'){t.roles.guardian=address;return;}
    t.pendingRoles[role]={address,activateAt:now+POLICY.roleDelayMs};
  }
  function applyRole(t,role,now) {
    const p=t.pendingRoles[role];invariant(p&&now>=p.activateAt,'Role announcement delay is active');
    t.roles[role]=p.address;delete t.pendingRoles[role];
  }
  function assertAccounting(t) {
    invariant(t.policyId===POLICY.id,'Fee policy mismatch');
    for(const k of ['available','reserved','paid','funded','collected','operations','feeDust','recovered'])natural(t[k],k);
    invariant(t.collected===t.available+t.reserved+t.paid+t.operations+t.feeDust+t.recovered,'Accounting conservation failed');
    invariant(t.funded===t.reserved+t.paid,'Funded liability accounting failed'); return true;
  }
  function nextSweep(lastCheck,hasActivity){return lastCheck+(hasActivity?POLICY.activeSweepMs:POLICY.idleSweepMs);}
  function stringify(v,space=0){return JSON.stringify(v,(_,x)=>typeof x==='bigint'?{$bigint:x.toString()}:x,space);}
  function parse(v){return JSON.parse(v,(_,x)=>x&&typeof x==='object'&&Object.keys(x).length===1&&typeof x.$bigint==='string'&&/^\d+$/.test(x.$bigint)?BigInt(x.$bigint):x);}
  return {PRICE_SCALE,POLICY,invariant,natural,timestamp,parseUnits,formatUnits,validateTax,splitFees,newPosition,purchase,incoming,outgoing,
    twap,checkedReference,shortfall,allocate,treasury,collect,fund,claim,cancel,recoverUnallocated,queueRole,applyRole,assertAccounting,
    nextSweep,stringify,parse};
});

