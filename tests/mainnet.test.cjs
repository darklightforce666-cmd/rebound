const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {makeHandler,MAINNET,isAddress}=require('../netlify/functions/chain.cjs'),D=require('../src/live-data.js');
const mint='3SohGcVPEwv6HS4DcSCMBE6RKu623aVzZKh4oWFppump',tokenProgram='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',token2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const secret='https://rpc.example.test/private-secret';
const event=(action,address=mint)=>({httpMethod:'GET',queryStringParameters:{action,address}});
function setup(results,options={}){
 const calls=[];
 const fetchImpl=async(url,init)=>{const body=JSON.parse(init.body);calls.push(body);assert.equal(init.redirect,'error');assert.ok(init.signal);return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:body.method==='getGenesisHash'?MAINNET:results[body.method]}));};
 return {calls,handler:makeHandler({env:{SOLANA_RPC_URL:secret},fetchImpl,...options})};
}
test('server and browser validate exact 32-byte base58 addresses',()=>{
 for(const valid of [mint,'11111111111111111111111111111111']){assert.equal(isAddress(valid),true);assert.equal(D.isAddress(valid),true);}
 for(const invalid of ['1'.repeat(44),'z'.repeat(44),'0'.repeat(32),'',null,'https://evil.test']){assert.equal(isAddress(invalid),false);assert.equal(D.isAddress(invalid),false);}
});
test('private RPC fails closed when unconfigured, rejects arbitrary requests and methods',async()=>{
 let fetched=0;const handler=makeHandler({env:{},fetchImpl:()=>{fetched++;}});
 assert.equal((await handler(event('status'))).statusCode,503);
 assert.equal((await handler(event('sendTransaction'))).statusCode,400);
 assert.equal((await handler(event('mint','bad'))).statusCode,400);
 assert.equal((await handler({...event('wallet'),httpMethod:'POST'})).statusCode,405);
 assert.equal((await handler({...event('wallet'),queryStringParameters:{action:'wallet',address:mint,url:secret}})).statusCode,400);
 assert.equal(fetched,0);
});
test('RPC genesis must match mainnet before accounts are read',async()=>{
 const calls=[];const handler=makeHandler({env:{SOLANA_RPC_URL:secret},fetchImpl:async(_,init)=>{calls.push(JSON.parse(init.body).method);return Response.json({result:'devnet'});}});
 const response=await handler(event('mint'));assert.equal(response.statusCode,503);assert.match(response.body,/WRONG_NETWORK/);assert.deepEqual(calls,['getGenesisHash']);
});
test('missing token is an explicit absent state, not a fabricated market',async()=>{
 const {handler,calls}=setup({getAccountInfo:{context:{slot:123},value:null}});
 const response=await handler(event('mint'));assert.equal(response.statusCode,200);assert.equal(JSON.parse(response.body).exists,false);
 assert.equal(calls[1].params[1].commitment,'finalized');
});
test('only an initialized mint owned by a supported token program passes',async()=>{
 const valid={context:{slot:123},value:{owner:token2022,executable:false,data:{parsed:{type:'mint',info:{isInitialized:true,decimals:6,supply:'18446744073709551615',extensions:[{extension:'tokenMetadata',state:{name:'Token',symbol:'TKN'}}]}}}}};
 let response=await setup({getAccountInfo:valid}).handler(event('mint'));
 assert.equal(response.statusCode,200);assert.equal(JSON.parse(response.body).supply,'18446744073709551615');assert.equal(JSON.parse(response.body).name,'Token');
 for(const mutate of [x=>x.value.owner=mint,x=>x.value.data.parsed.type='account',x=>x.value.data.parsed.info.isInitialized=false]){
  const invalid=structuredClone(valid);mutate(invalid);response=await setup({getAccountInfo:invalid}).handler(event('mint'));assert.equal(response.statusCode,422);
 }
});
test('wallet data aggregates token accounts with integer precision across both programs',async()=>{
 let counter=0;
 const {handler}=setup({}, {fetchImpl:async(_,init)=>{
  const b=JSON.parse(init.body);let result;
  if(b.method==='getGenesisHash')result=MAINNET;
  else if(b.method==='getBalance')result={context:{slot:123},value:1000000001};
  else{counter++;const owner=b.params[1].programId;result={context:{slot:124},value:owner===tokenProgram?[1,2].map(()=>({account:{owner,data:{parsed:{type:'account',info:{owner:mint,mint,tokenAmount:{amount:'9007199254740993',decimals:6}}}}}})):[]};}
  return Response.json({result});
 }});
 const response=await handler(event('wallet')),data=JSON.parse(response.body);assert.equal(response.statusCode,200);assert.equal(counter,2);
 assert.equal(data.lamports,'1000000001');assert.equal(data.tokens[0].amount,'18014398509481986');assert.equal(D.units(data.tokens[0].amount,6),'18,014,398,509.481986');
});
test('unsafe balances and provider errors never become zero balances or leak a URL/key',async()=>{
 const response=await setup({getBalance:{context:{slot:123},value:Number.MAX_SAFE_INTEGER+1},getTokenAccountsByOwner:{context:{slot:123},value:[]}}).handler(event('wallet'));
 assert.equal(response.statusCode,502);assert.equal(JSON.parse(response.body).lamports,undefined);
 for(const fetchImpl of [async()=>{throw Error(secret);},async()=>Response.json({error:{message:secret}}),async()=>new Response('not json '+secret)]){
  const r=await makeHandler({env:{SOLANA_RPC_URL:secret},fetchImpl})(event('status'));assert.equal(r.statusCode,502);assert.ok(!r.body.includes('private-secret'));assert.ok(!r.body.includes('rpc.example'));
 }
});
test('per-client request budget is enforced before upstream calls',async()=>{
 const {handler,calls}=setup({});for(let i=0;i<30;i++)assert.equal((await handler(event('status'))).statusCode,200);
 assert.equal((await handler(event('status'))).statusCode,429);assert.equal(calls.length,1);
});
test('expired mainnet verification is refreshed and rejects a switched cluster',async()=>{
 let now=0,hash=MAINNET;
 const handler=makeHandler({env:{SOLANA_RPC_URL:secret},now:()=>now,fetchImpl:async()=>Response.json({result:hash})});
 assert.equal((await handler(event('status'))).statusCode,200);now=61000;hash='devnet';assert.equal((await handler(event('status'))).statusCode,503);
});
test('market selection cannot substitute another token, chain, or invalid pair',()=>{
 const pair={chainId:'solana',pairAddress:mint,baseToken:{address:mint},liquidity:{usd:10}};
 assert.equal(D.selectPair([{...pair,chainId:'ethereum'},{...pair,baseToken:{address:'wrong'}},{...pair,pairAddress:'https://evil.test'},pair],mint),pair);
 assert.equal(D.selectPair([],mint),null);assert.throws(()=>D.selectPair({},mint));
 assert.equal(D.units('1',9,6),'<0.000001');
});
test('production output contains no demo runtime, server files, or environment secrets',()=>{
 const root=path.resolve(__dirname,'..');require('../scripts/build.cjs').build();
 const html=fs.readFileSync(path.join(root,'dist/index.html'),'utf8'),app=fs.readFileSync(path.join(root,'dist/src/app.js'),'utf8');
 assert.doesNotMatch(html,/fixtures\.cjs|engine\.cjs|Reset demo|PROTOTYPE/);
 assert.doesNotMatch(app,/ReboundFixtures|ReboundEngine|Math\.random|demoBalances|localStorage/);
 for(const p of ['src/fixtures.cjs','src/engine.cjs','netlify','server','.env','contracts','preview'])assert.ok(!fs.existsSync(path.join(root,'dist',p)),p);
 const browserFiles=fs.readdirSync(path.join(root,'dist/src')).filter(p=>p.endsWith('.js')).map(p=>fs.readFileSync(path.join(root,'dist/src',p),'utf8')).join('\n');
 assert.doesNotMatch(browserFiles,/SOLANA_RPC_URL|private-secret|api-key=/);
 assert.match(html,/rebound:unlocked/);assert.match(app,/AbortController/);assert.match(app,/address!==wallet.address/);
});
