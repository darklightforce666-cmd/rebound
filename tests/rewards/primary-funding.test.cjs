'use strict';
// Spec §8.2 / §19: primary 15 % stays on the dev wallet, is never re-split; new credits are
// processed once despite simultaneous outgoing activity; holder-only deposits are not new funding.
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../../server/rewards/primary-funding.cjs');
const SOL=1000000000n,DEV='DevWallet111',SYS='11111111111111111111111111111111';
let slot=1000;
function tx({sig,payer='Other',pre,post,fee=5000n,transfers=[]}){
 slot++;const keys=[payer,...new Set([DEV,...transfers.flatMap(t=>[t.from,t.to])])].filter((k,i,a)=>a.indexOf(k)===i);
 const bal=keys.map(k=>k===DEV?[pre,post]:[0n,0n]);
 return{slot,blockTime:slot,transaction:{signatures:[sig],message:{accountKeys:keys,instructions:transfers.map(t=>({programId:SYS,parsed:{type:'transfer',info:{source:t.from,destination:t.to,lamports:Number(t.lamports)}}}))}},meta:{err:null,fee:Number(fee),preBalances:bal.map(b=>Number(b[0])),postBalances:bal.map(b=>Number(b[1])),innerInstructions:[]}};
}
const empty={credited:0n,holderAwaiting:0n,holderAvailable:0n,holderReserved:0n,holderPaid:0n,retained:0n,carry:0n,operationalReserve:0n,throughSlot:null};

test('1 SOL → 0.85 holder liability + 0.15 retained; deposit moves only the liability; no new funding → nothing re-split; next 1 SOL → retained 0.30',()=>{
 const intents=new Map([['dep1',{kind:'holder_deposit',amount:String(850000000n)}]]);
 const txs=[tx({sig:'in1',pre:0n,post:SOL,transfers:[{from:'Buyer',to:DEV,lamports:SOL}]}),
  tx({sig:'dep1',payer:'FeePayer',pre:SOL,post:SOL-850000000n,transfers:[{from:DEV,to:'Treasury',lamports:850000000n}]}),
  tx({sig:'in2',pre:150000000n,post:SOL+150000000n,transfers:[{from:'Buyer',to:DEV,lamports:SOL}]})];
 const c=txs.map(t=>F.classify(t,DEV,intents));
 const a=F.reconcile(empty,c.slice(0,2));
 assert.equal(a.state.holderAwaiting,0n);assert.equal(a.state.holderAvailable,850000000n);assert.equal(a.state.retained,150000000n);
 assert.equal(a.credits.length,1);assert.deepEqual(a.incidents,[]);
 // A cycle with no new transactions creates no credit: the retained 0.15 SOL is never split again.
 assert.equal(F.reconcile(a.state,[]).credits.length,0);
 const b=F.reconcile(a.state,c.slice(2));
 assert.equal(b.credits.length,1);assert.equal(b.credits[0].gross,SOL);assert.equal(b.state.retained,300000000n);assert.equal(b.state.holderAwaiting,850000000n);
});

test('an unrelated outflow in the same transaction does not hide the inflow; fees are not funding',()=>{
 const t=tx({sig:'mixed',payer:DEV,pre:2n*SOL,post:2n*SOL+SOL-400000000n-5000n,transfers:[{from:'X',to:DEV,lamports:SOL},{from:DEV,to:'Y',lamports:400000000n}]});
 const r=F.reconcile(empty,[F.classify(t,DEV)]);
 assert.equal(r.credits[0].gross,SOL);
 assert.deepEqual(r.movements.map(m=>[m.classification,m.lamports]),[['network_fee',5000n],['funding',SOL],['owner_withdrawal',400000000n]]);
});

test('program-level lamport moves (e.g. creator-fee collection without a system transfer) count once as funding',()=>{
 const t=tx({sig:'prog',pre:0n,post:123456n,transfers:[]});const c=F.classify(t,DEV);
 assert.equal(c.residual,123456n);assert.equal(F.reconcile(empty,[c]).credits[0].gross,123456n);
});

test('reprocessing the same finalized transactions never credits twice',()=>{
 const t=tx({sig:'once',pre:0n,post:SOL,transfers:[{from:'B',to:DEV,lamports:SOL}]}),c=[F.classify(t,DEV)];
 const first=F.reconcile(empty,c),again=F.reconcile(first.state,c);
 assert.equal(first.credits.length,1);assert.equal(again.credits.length,0);assert.equal(again.state.credited,SOL);
});

test('owner withdrawal may consume retained funds but never holder liabilities: exact shortfall is reported',()=>{
 const c1=F.classify(tx({sig:'in',pre:0n,post:SOL,transfers:[{from:'B',to:DEV,lamports:SOL}]}),DEV);
 const ok=F.classify(tx({sig:'w1',payer:'P',pre:SOL,post:SOL-150000000n,transfers:[{from:DEV,to:'Owner',lamports:150000000n}]}),DEV);
 const r1=F.reconcile({...empty,operationalReserve:0n},[c1,ok]);assert.deepEqual(r1.incidents,[]);
 const bad=F.classify(tx({sig:'w2',payer:'P',pre:850000000n,post:800000000n,transfers:[{from:DEV,to:'Owner',lamports:50000000n}]}),DEV);
 const r2=F.reconcile(r1.state,[bad]);assert.equal(r2.incidents[0].reason,'insufficient_backing');assert.equal(r2.incidents[0].shortfall,50000000n);
});

test('holder-only deposit that differs from its intent is an incident; failed transactions only cost fees',()=>{
 const intents=new Map([['dep',{kind:'holder_deposit',amount:'100'}]]);
 const r=F.reconcile({...empty,holderAwaiting:100n},[F.classify(tx({sig:'dep',payer:'P',pre:1000n,post:880n,transfers:[{from:DEV,to:'T',lamports:120n}]}),DEV,intents)]);
 assert.equal(r.incidents[0].reason,'holder_deposit_amount_mismatch');
 const failed=tx({sig:'f',payer:DEV,pre:1000n,post:995n});failed.meta.err={InstructionError:[0,'x']};
 const rf=F.reconcile(empty,[F.classify(failed,DEV)]);assert.equal(rf.credits.length,0);assert.equal(rf.movements[0].classification,'network_fee');
});

test('opening credit is explicit, one-time and cannot exceed balance minus reserve; cutoff attribution by block time',()=>{
 assert.equal(F.opening({balance:10n,requestedCredit:7n,operationalReserve:3n}),7n);
 assert.throws(()=>F.opening({balance:10n,requestedCredit:8n,operationalReserve:3n}),e=>e.code==='INSUFFICIENT_BACKING');
 assert.deepEqual(F.fundingThrough([{time:10},{time:20},{time:21}],20).map(c=>c.time),[10,20]);
 const before=F.classify(tx({sig:'old',pre:0n,post:5n,transfers:[{from:'B',to:DEV,lamports:5n}]}),DEV);
 assert.equal(F.reconcile(empty,[before],{openingSlot:before.slot}).credits.length,0);
});
