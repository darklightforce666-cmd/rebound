'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const I=require('../../server/rewards/indexer.cjs'),Project=require('../../server/rewards/project.cjs'),R=require('../../server/rewards/receipts.cjs'),P=require('../../server/rewards/policy.cjs'),C=require('./capture.cjs');
const fixturePath=process.env.PUMP_EXECUTION_FIXTURE||__dirname+'/../../contracts/v2/artifact/pump-execution.json';
const fixture=fs.existsSync(fixturePath)?JSON.parse(fs.readFileSync(fixturePath,'utf8')):null;
const protocolTest=fixture?test:test.skip;
function replay(){let ownership=new Map();const events=[],holds=[];for(const[i,row]of fixture.history.entries()){const p=I.parseTransaction(C.transaction(row),{slot:row.slot,time:row.time,transactionIndex:i,coins:[fixture],ownership});ownership=p.ownership;events.push(...p.events);holds.push(...p.holds);}return{...Project.project(events,fixture),events,parseHolds:holds};}
protocolTest('captured real Pump/PumpSwap instructions replay principal, protocol split, creator fees and graduation',()=>{
 const p=replay();assert.deepEqual(p.parseHolds,[]);assert.deepEqual(p.exits,[]);assert.deepEqual(p.lots.map(l=>l.cost),[28310n,28310n,415919n]);assert.deepEqual(p.accruals.map(a=>a.amount),[84n,84n,255015910n,1233n]);
 assert.equal(p.holds.length,1);assert.equal(p.holds[0].reason,'entry_price_impact_limit');assert.equal(p.observations.at(-1).realQuote,67406264639n);assert.equal(p.observations.at(-1).base,206899000000000n);assert.equal(p.observations.at(-1).virtualQuote,17584505290n);
});
protocolTest('first-trade direct collection and graduated WSOL unwrap attribute only once, in instruction order',()=>{
 const p=replay(),ledger=R.attribute(p,p.events);assert.deepEqual(ledger.receipts.map(r=>r.amount),[0n,84n,84n,255017143n]);assert.equal(ledger.receipts.at(-1).sources.length,2);assert.equal(ledger.receipts.at(-1).sources.at(-1).conversions.length,1);assert.equal(P.sum(ledger.pending.map(a=>a.remaining)),0n);
 const noConversion={...p,conversions:[]};assert.equal(R.attribute(noConversion,p.events).receipts.at(-1).amount,255015910n);
});
protocolTest('unsolicited native amounts and rent cannot become new creator fees',()=>{
 const p=replay();p.receipts.at(-1).distributed+=1000000000n;const l=R.attribute(p,p.events);assert.equal(l.receipts.at(-1).nonFee,1000000000n);assert.equal(l.receipts.at(-1).amount,255017143n);
});
test('evidence and manifests survive PostgreSQL JSONB key ordering',()=>{assert.equal(P.stable({z:[{c:3n,b:2}],a:1}),P.stable({a:1,z:[{b:2,c:'3'}]}));});
test('price history can become valid after early low liquidity and after a complete new-market window',()=>{
 const o=Array.from({length:61},(_,i)=>({time:i*60,slot:i,quoteModel:'amm',base:'1000000000',realQuote:i<29?'1':'10000000000',virtualQuote:'0',canonical:true,finalized:true,asset:'native-SOL',market:'amm'}));o[29]={time:1740,slot:29,invalidated:true};assert.equal(P.price(o,3600,{complete:true,throughTime:3600}).outcome,'pass');assert.equal(P.price(o,1800,{complete:true,throughTime:1800}).outcome,'hold');
});
module.exports={replay,fixture};
