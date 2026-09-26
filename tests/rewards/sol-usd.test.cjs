'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../../server/rewards/sol-usd.cjs'),W=require('../../server/rewards/wire.cjs');
const USD=10n**12n;
test('Pyth price × 10^expo converts exactly to usd_pico; invalid prices are rejected',()=>{
 assert.equal(S.toPico(15123456789n,-8),151234567890000n);assert.equal(S.toPico(1n,-14),0n);assert.equal(S.toPico(0n,-8),null);assert.equal(S.toPico(-5n,-8),null);
});
test('observations are validated for age (≤30 s), confidence (≤1%) and never from the future',()=>{
 const o=S.observation({price:15000000000n,conf:10000000n,expo:-8,publishTime:1000,source:'t'});
 assert.equal(o.price,150n*USD);assert.equal(S.valid(o,1030).ok,true);
 assert.equal(S.valid(o,1031).reason,'sol_usd_stale');assert.equal(S.valid(o,999).reason,'sol_usd_after_time');
 assert.equal(S.valid({...o,conf:2n*USD},1000).reason,'sol_usd_confidence');assert.equal(S.valid(null,1).reason,'sol_usd_unavailable');
 const fx=S.lookup([o,{...o,time:1020,price:151n*USD}]);assert.equal(fx(1025).price,151n*USD);assert.equal(fx(1019).price,150n*USD);assert.equal(fx(1060),null);assert.equal(fx(990),null);
});
test('Hermes/Benchmarks responses are parsed only for the configured SOL/USD feed',()=>{
 const body={binary:{encoding:'hex',data:['aa']},parsed:[{id:S.FEED,price:{price:'14987654321',conf:'7654321',expo:-8,publish_time:1790000000}},{id:'00'.repeat(32),price:{price:'1',conf:'0',expo:-8,publish_time:1790000000}}]};
 const r=S.parseHermes(body,'pyth-benchmarks');assert.equal(r.length,1);assert.equal(r[0].price,149876543210000n);assert.equal(r[0].time,1790000000);
});
test('Hermes requires an API key and reports rejection explicitly',async()=>{
 await assert.rejects(S.hermesAt(100,{cfg:{configured:false}}),e=>e.code==='SOL_USD_SOURCE_UNCONFIGURED');
 await assert.rejects(S.hermesAt(100,{cfg:{configured:true,key:'k',benchmarks:'https://b'},fetchImpl:async()=>({status:401,ok:false})}),e=>e.code==='SOL_USD_SOURCE_UNAUTHORIZED');
 const seen=[];const out=await S.hermesAt(1790000030,{cfg:{configured:true,key:'k',benchmarks:'https://b'},fetchImpl:async(url,init)=>{seen.push([url,init.headers.authorization]);return{status:200,ok:true,json:async()=>({parsed:[{id:'0x'+S.FEED,price:{price:'15000000000',conf:'1',expo:-8,publish_time:1790000020}}]})};}});
 assert.equal(out[0].time,1790000020);assert.match(seen[0][0],/\/v1\/updates\/price\/1790000000\/30\?ids=0x/);assert.equal(seen[0][1],'Bearer k');
});
test('PriceUpdateV2 decoding requires the Anchor discriminator, Full verification and the SOL/USD feed',()=>{
 const build=(level=1,feed=S.FEED)=>{const parts=[W.hash('account:PriceUpdateV2').subarray(0,8),Buffer.alloc(32),level===1?Buffer.from([1]):Buffer.from([0,5]),Buffer.from(feed,'hex')];
  const nums=Buffer.alloc(8*6+4+8);let o=0;nums.writeBigInt64LE(15000000000n,o);o+=8;nums.writeBigUInt64LE(10000000n,o);o+=8;nums.writeInt32LE(-8,o);o+=4;nums.writeBigInt64LE(1790000000n,o);o+=8;o+=24;nums.writeBigUInt64LE(123n,o);
  return Buffer.concat([...parts,nums]);};
 const d=S.decodePriceUpdateV2(build());assert.equal(d.full,true);assert.equal(d.price,15000000000n);assert.equal(d.expo,-8);assert.equal(d.publishTime,1790000000);assert.equal(d.postedSlot,123n);
 assert.equal(S.decodePriceUpdateV2(build(0)).full,false);assert.equal(S.decodePriceUpdateV2(Buffer.alloc(100)),null);
});

test('Hermes latest: keyed request for the configured feed only; no key → no request',async()=>{
 const seen=[];const f=async(url,init)=>{seen.push([url,init.headers.authorization]);return{status:200,ok:true,json:async()=>({parsed:[{id:S.FEED,price:{price:'15000000000',conf:'1000000',expo:-8,publish_time:1790000001}},{id:'0x'+S.FEED,price:{price:'15100000000',conf:'1000000',expo:-8,publish_time:1790000002}}]})};};
 assert.equal(await S.hermesLatest({cfg:{configured:false},fetchImpl:f}),null);assert.equal(seen.length,0);
 const o=await S.hermesLatest({cfg:{configured:true,key:'k',hermes:'https://h'},fetchImpl:f});
 assert.equal(o.time,1790000002);assert.equal(o.price,151n*USD);assert.equal(o.source,'pyth-hermes');
 assert.deepEqual(seen,[[`https://h/v2/updates/price/latest?ids[]=0x${S.FEED}&parsed=true`,'Bearer k']]);
 await assert.rejects(S.hermesLatest({cfg:{configured:true,key:'bad',hermes:'https://h'},fetchImpl:async()=>({status:401,ok:false})}),e=>e.code==='SOL_USD_SOURCE_UNAUTHORIZED');
});
