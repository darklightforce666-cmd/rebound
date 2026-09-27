'use strict';
// The hosted worker runs a MINIFIED bundle (supabase/functions/rebound-worker). Minification renamed the
// bn.js class, and every pump.fun buy then failed to parse on the server while the unbundled tests passed.
// This test parses a real Pump buy (cloned mainnet program in LiteSVM) with the indexer bundled and minified
// the way the hosted worker is, and checks that the purchase and its SOL payment are recognized.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {ready,world,SOL}=require('./pump-world.cjs');
const t=ready?test:(name,fn)=>test(name,{skip:'needs contracts/v3/fixtures/mainnet (clone-protocol.cjs) and the SBF build'},fn);

t('a real Pump buy parses to a purchase with its SOL payment inside the minified hosted bundle',async()=>{
 const w=await world();const sig=await w.buy(w.primary,w.trader,1n*SOL),tx=w.conn.parsed.get(sig);assert.ok(tx);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rebound-bundle-')),out=path.join(dir,'indexer.min.cjs');
 require('esbuild').buildSync({stdin:{contents:`module.exports=require(${JSON.stringify(path.join(__dirname,'../../server/rewards/indexer.cjs'))});`,resolveDir:__dirname,loader:'js'},
  bundle:true,platform:'node',format:'cjs',minify:true,keepNames:false,outfile:out,logLevel:'error',nodePaths:[path.join(__dirname,'../../node_modules')]});
 try{
  const B=require(out),mint=w.primary.toBase58();
  const r=B.parseTransaction(tx,{slot:tx.slot,time:tx.blockTime,transactionIndex:0,coins:[{mint,intake:null,sharing_config:null,current_creator:null}]});
  assert.deepEqual(r.holds,[],'no parser hold: '+JSON.stringify(r.holds).slice(0,300));
  const buy=r.events.find(e=>e.kind==='purchase_candidate');assert.ok(buy,'the buy is a purchase');
  assert.match(String(buy.data.event.solAmount??buy.data.event.quoteAmount),/^\d+$/,'amounts are decimal strings, not bn.js internals');
  assert.match(buy.data.actualQuote,/^[1-9]\d*$/);
  assert.ok(r.events.some(e=>e.kind==='funding_transfer'&&e.data.from===w.trader.publicKey.toBase58()),'the SOL payment is recorded');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

t('ingest stores a real buy together with its SOL payment under the mint (the payment proves the purchase cost)',async()=>{
 const w=await world(),{supabaseDb}=require('./pg.cjs'),Wk=require('../../server/rewards/worker-v3.cjs'),H=require('../../server/rewards/history-v3.cjs');
 const sig=await w.buy(w.primary,w.trader,1n*SOL),tx=w.conn.parsed.get(sig),mint=w.primary.toBase58();
 const db=await supabaseDb();try{
  await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES($1,'h','active','primary','mainnet_test','v3','rebound-v3.2-test')",[mint]);
  const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0],m=H.marketAddresses(mint);
  const rpc={async call(method,p){if(method==='getSlot')return tx.slot;if(method==='getBlockTime')return tx.blockTime;
   if(method==='getSignaturesForAddress')return [m.mint,m.curve].includes(p[0])?[{signature:sig,slot:tx.slot,err:null,transactionIndex:0}]:[];
   if(method==='getTransaction')return tx;if(method==='getBlock')return{signatures:[sig]};throw Error('unexpected '+method);}};
  await Wk.ingest({db,rpc},coin,{holderCheckSeconds:0});
  const kinds=Object.fromEntries((await db.query('SELECT kind,count(*)::int n FROM reward_events WHERE mint=$1 GROUP BY kind',[mint])).rows.map(r=>[r.kind,r.n]));
  assert.equal(kinds.purchase_candidate,1);assert.ok(kinds.funding_transfer>=1,'payment events are stored under the mint: '+JSON.stringify(kinds));
  assert.equal((await db.query('SELECT count(*)::int n FROM reward_events WHERE mint IS NULL')).rows[0].n,0);
 }finally{await db.close();}
});
