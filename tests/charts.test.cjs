const test=require('node:test'),assert=require('node:assert/strict');
const {makeService,selectPool,candlesFrom,SOL}=require('../server/charts.cjs');
const {makeHandler}=require('../netlify/functions/charts.cjs');
const mint='3SohGcVPEwv6HS4DcSCMBE6RKu623aVzZKh4oWFppump',other='11111111111111111111111111111111';
const now=1800000000000;
function pool(overrides={}){return{type:'pool',id:'solana_'+mint,attributes:{address:mint,reserve_in_usd:'10',volume_usd:{h24:'20'}},relationships:{base_token:{data:{id:'solana_'+mint}},quote_token:{data:{id:'solana_'+SOL}},dex:{data:{id:'pumpswap'}}},...overrides};}
const data=()=>({meta:{base:{address:mint,symbol:'REBOUND'},quote:{address:SOL}},data:{attributes:{ohlcv_list:[[1799999100,0.01,0.03,0.01,0.02,40],[1799998200,0.01,0.02,0.005,0.01,20]]}}});
test('charts bind to the exact base mint and SOL quote, with explicit Pump market preference',()=>{
 const valid=pool(),wrongMint=pool({relationships:{base_token:{data:{id:'solana_'+other}}}}),wrongChain=pool({id:'ethereum_'+mint}),badAddress=pool({id:'solana_https://bad.test',attributes:{address:'https://bad.test',reserve_in_usd:100}});
 const side=pool({id:'solana_'+other,attributes:{address:other,reserve_in_usd:100000,volume_usd:{h24:100000}},relationships:{...valid.relationships,dex:{data:{id:'other-dex'}}}});
 assert.equal(selectPool([wrongMint,wrongChain,badAddress,side,valid],mint),valid);
 assert.equal(selectPool([wrongMint,wrongChain,badAddress],mint),null);
 assert.throws(()=>selectPool({},mint));
});
test('provider candles sort chronologically and reject substitution, malformed or duplicate OHLC data',()=>{
 assert.deepEqual(candlesFrom(data(),mint,900,now).map(c=>c.time),[1799998200,1799999100]);
 for(const mutate of [d=>d.meta.base.address=other,d=>d.meta.quote.address=other,d=>d.data.attributes.ohlcv_list.push(d.data.attributes.ohlcv_list[0]),d=>d.data.attributes.ohlcv_list[0][2]=0.001,d=>d.data.attributes.ohlcv_list[0][5]=-1,d=>d.data.attributes.ohlcv_list[0][0]+=1,d=>d.data.attributes.ohlcv_list[0][0]=1800000900,d=>d.data.attributes.ohlcv_list[0][1]=null]){
  const d=data();mutate(d);assert.throws(()=>candlesFrom(d,mint,900,now));
 }
});
test('chart requests select the token explicitly, preserve units, coalesce callers and cache provider requests',async()=>{
 const calls=[];const service=makeService({now:()=>now,fetchImpl:async(url,init)=>{calls.push(url);assert.equal(init.redirect,'error');assert.ok(init.signal);return Response.json(url.includes('/ohlcv/')?data():{data:[pool()]});}});
 const a=await Promise.all([service({mint,currency:'sol'}),service({mint,currency:'sol'})]);
 assert.equal(calls.length,2);assert.equal(a[0].currency,'SOL');assert.equal(a[0].volumeCurrency,'USD');assert.equal(a[0].candles.length,2);
 assert.match(calls[1],new RegExp('token='+mint));assert.match(calls[1],/currency=token/);assert.match(calls[1],/include_empty_intervals=false/);
 await service({mint,currency:'sol'});assert.equal(calls.length,2);
});
test('unknown tokens and empty markets never get substitute or artificial candles',async()=>{
 const unknown=makeService({now:()=>now,fetchImpl:async()=>new Response('',{status:404})});
 assert.equal((await unknown({mint})).state,'awaiting_market');assert.deepEqual((await unknown({mint})).candles,[]);
 const empty=makeService({now:()=>now,fetchImpl:async url=>Response.json(url.includes('/ohlcv/')?{...data(),data:{attributes:{ohlcv_list:[]}}}:{data:[pool()]})});
 assert.equal((await empty({mint})).state,'awaiting_trades');
});
test('public charts reject arbitrary URLs/methods and hide upstream error details',async()=>{
 let count=0;const service=makeService({fetchImpl:async()=>{count++;throw Error('https://private.example/secret');}}),handler=makeHandler({service});
 const event=query=>({httpMethod:'GET',queryStringParameters:query});
 for(const query of [{mint:'bad'},{mint,interval:'__proto__'},{mint,currency:'eur'},{mint,url:'https://private.example'}])assert.equal((await handler(event(query))).statusCode,400);
 assert.equal((await handler({...event({mint}),httpMethod:'POST'})).statusCode,405);assert.equal(count,0);
 const response=await handler(event({mint}));assert.equal(response.statusCode,502);assert.doesNotMatch(response.body,/secret|private.example/);
});
test('provider rate limits and bounded response sizes fail cleanly',async()=>{
 for(const status of [429,500]){
  const service=makeService({fetchImpl:async()=>new Response('',{status})});
  const response=await makeHandler({service})({httpMethod:'GET',queryStringParameters:{mint}});assert.equal(response.statusCode,status===429?429:502);
 }
 const large=makeService({fetchImpl:async()=>new Response('x'.repeat(1000001))});await assert.rejects(large({mint}),/invalid chart data/);
});
