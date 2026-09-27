'use strict';
// Mint-scoped finalized history (spec §7.1). Instead of scanning every mainnet block, collect
// every transaction that touched the mint, its canonical markets or ANY token account of the mint
// (plain SPL `transfer` does not reference the mint, so token accounts are discovered from the
// transactions and followed until no new account appears). Transactions are then ordered exactly
// by (slot, index in block) and parsed with the CPI-ordered parser (indexer.cjs).
// Coverage is reported honestly: any page limit, fetch failure or unresolved order is a named
// incompleteness, never silently ignored.
const Pump=require('./pump.cjs'),W=require('./wire.cjs'),I=require('./indexer.cjs');

class Rpc{
 constructor(url,{fetchImpl=fetch,minIntervalMs=0,retries=5}={}){if(!url)throw Error('RPC URL required');this.url=url;this.fetch=fetchImpl;this.id=0;this.min=minIntervalMs;this.last=0;this.retries=retries;this.calls=0;}
 async call(method,params=[]){
  for(let attempt=0;;attempt++){
   const wait=this.last+this.min-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));this.last=Date.now();this.calls++;
   let res;try{res=await this.fetch(this.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++this.id,method,params}),signal:AbortSignal.timeout(30000)});}
   catch(e){if(attempt<this.retries){await new Promise(r=>setTimeout(r,500*2**attempt));continue;}throw Object.assign(Error('RPC unreachable'),{code:'RPC_UNAVAILABLE'});}
   if(res.status===429||res.status>=500){if(attempt<this.retries){await new Promise(r=>setTimeout(r,1000*2**attempt));continue;}throw Object.assign(Error('RPC HTTP '+res.status),{code:'RPC_UNAVAILABLE'});}
   const body=await res.json();if(body.error){if(attempt<this.retries&&[-32005,-32004,-32014].includes(body.error.code)){await new Promise(r=>setTimeout(r,1000*2**attempt));continue;}throw Object.assign(Error('RPC '+method+' error '+body.error.code),{code:'RPC_ERROR',rpcCode:body.error.code});}
   return body.result;
  }
 }
 // JSON-RPC batch: one HTTP round trip for many calls. Returns results in order; an item that errors
 // is retried alone (a failure never becomes silent data).
 async batch(calls){
  if(!calls.length)return[];
  for(let attempt=0;;attempt++){
   const wait=this.last+this.min-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));this.last=Date.now();this.calls+=calls.length;
   const base=this.id;const body=calls.map(([method,params],i)=>({jsonrpc:'2.0',id:base+i+1,method,params}));this.id+=calls.length;
   let res;try{res=await this.fetch(this.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});}
   catch(e){if(attempt<this.retries){await new Promise(r=>setTimeout(r,500*2**attempt));continue;}throw Object.assign(Error('RPC unreachable'),{code:'RPC_UNAVAILABLE'});}
   if(res.status===429||res.status>=500){if(attempt<this.retries){await new Promise(r=>setTimeout(r,1000*2**attempt));continue;}throw Object.assign(Error('RPC HTTP '+res.status),{code:'RPC_UNAVAILABLE'});}
   const out=await res.json();if(!Array.isArray(out)){if(attempt<this.retries){await new Promise(r=>setTimeout(r,1000*2**attempt));continue;}throw Object.assign(Error('RPC batch not supported'),{code:'RPC_ERROR'});}
   const byId=new Map(out.map(r=>[r.id,r]));const results=[];
   for(const [i,[method,params]] of calls.entries()){const r=byId.get(base+i+1);results.push(!r||r.error?await this.call(method,params):r.result);}
   return results;
  }
 }
}

function marketAddresses(mint){
 const m=W.pk(mint);
 return{mint:m.toBase58(),curve:Pump.SDK.bondingCurvePda(m).toBase58(),pool:Pump.SDK.canonicalPumpPoolPda(m).toBase58(),poolAuthority:Pump.SDK.pumpPoolAuthorityPda(m).toBase58()};
}

// All finalized signatures of `address` newer than `until` (exclusive). Complete iff the last
// page was short (reached the address's first activity or `until`).
async function signaturesFor(rpc,address,{until=null,maxPages=200,pageSize=1000}={}){
 const out=[];let before;
 for(let page=0;page<maxPages;page++){
  const opts={limit:pageSize,commitment:'finalized'};if(before)opts.before=before;if(until)opts.until=until;
  const batch=await rpc.call('getSignaturesForAddress',[address,opts]);
  out.push(...batch);if(batch.length<pageSize)return{signatures:out,complete:true};before=batch.at(-1).signature;
 }
 return{signatures:out,complete:false,reason:'signature_page_limit'};
}

// Mainnet carries v1 transactions (message `transactionConfig`); jsonParsed keeps the v0 shape we read.
// Requesting a lower version makes the RPC refuse the transaction (-32015), which would silently
// become incomplete coverage for every mint touched by v1 traffic.
const TX_VERSION=1;
// Position inside the finalized block, as reported by the RPC (getTransaction / getSignaturesForAddress).
const reportedIndex=(tx,s)=>Number.isInteger(tx?.transactionIndex)?tx.transactionIndex:Number.isInteger(s?.transactionIndex)?s.transactionIndex:null;

// Collect, fetch and order the mint's full finalized history.
async function collect(rpc,mint,{maxAccounts=5000,maxTransactions=50000,onProgress=()=>{}}={}){
 // Everything finalized at or before `head` is guaranteed to be in the signature lists below.
 const head=await rpc.call('getSlot',[{commitment:'finalized'}]);
 const addr=marketAddresses(mint),queue=[addr.mint,addr.curve,addr.pool],seenAddr=new Set(queue),sigs=new Map(),txs=new Map(),incomplete=[];
 while(queue.length){
  const a=queue.shift();const r=await signaturesFor(rpc,a);if(!r.complete)incomplete.push({address:a,reason:r.reason});
  for(const s of r.signatures)if(!sigs.has(s.signature))sigs.set(s.signature,s);
  // Fetch newly seen transactions and discover the mint's token accounts inside them.
  for(const s of r.signatures){
   if(txs.has(s.signature))continue;if(txs.size>=maxTransactions){incomplete.push({reason:'transaction_limit'});break;}
   const tx=await rpc.call('getTransaction',[s.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:TX_VERSION}]);
   if(!tx){incomplete.push({signature:s.signature,reason:'transaction_unavailable'});continue;}
   tx._index=reportedIndex(tx,s);txs.set(s.signature,tx);
   const keys=tx.transaction.message.accountKeys.map(k=>typeof k==='string'?k:k.pubkey);
   for(const b of [...(tx.meta?.preTokenBalances||[]),...(tx.meta?.postTokenBalances||[])]){
    if(b.mint!==addr.mint)continue;const acct=keys[b.accountIndex];
    if(!seenAddr.has(acct)){if(seenAddr.size>=maxAccounts){incomplete.push({reason:'account_limit'});continue;}seenAddr.add(acct);queue.push(acct);}
   }
  }
  onProgress({addresses:seenAddr.size,pending:queue.length,transactions:txs.size});
 }
 // Exact in-block order for slots with more than one relevant transaction.
 const bySlot=new Map();for(const tx of txs.values()){const k=tx.slot;if(!bySlot.has(k))bySlot.set(k,[]);bySlot.get(k).push(tx);}
 const ordered=[];
 for(const slot of [...bySlot.keys()].sort((a,b)=>a-b)){
  const group=bySlot.get(slot);
  if(group.every(t=>t._index!=null)){group.sort((a,b)=>a._index-b._index);}
  else if(group.length>1){
   const block=await rpc.call('getBlock',[slot,{transactionDetails:'signatures',rewards:false,commitment:'finalized',maxSupportedTransactionVersion:TX_VERSION}]);
   const index=new Map((block?.signatures||[]).map((s,i)=>[s,i]));
   if(group.some(t=>!index.has(t.transaction.signatures[0]))){incomplete.push({slot,reason:'in_block_order_unavailable'});group.forEach((t,i)=>t._index=i);}
   else group.forEach(t=>t._index=index.get(t.transaction.signatures[0]));
   group.sort((a,b)=>a._index-b._index);
  }else group[0]._index=group[0]._index??0;
  ordered.push(...group);
 }
 const failed=ordered.filter(t=>t.meta?.err).length;
 return{mint:addr.mint,markets:addr,transactions:ordered,accounts:[...seenAddr],coverage:{complete:incomplete.length===0,incomplete,firstSlot:ordered[0]?.slot??null,throughSlot:head,lastActivitySlot:ordered.at(-1)?.slot??null,transactions:ordered.length,failedTransactions:failed,addresses:seenAddr.size}};
}

// Parse ordered transactions into events (same shape as reward_events rows).
function parseAll(history,coin){
 const events=[],holds=[];let ownership=new Map();
 for(const tx of history.transactions){
  const r=I.parseTransaction(tx,{slot:tx.slot,time:tx.blockTime,transactionIndex:tx._index,coins:[coin],ownership});ownership=r.ownership;
  for(const e of r.events)events.push({...e,transactionIndex:tx._index,time:tx.blockTime});
  holds.push(...r.holds);
 }
 return{events,holds};
}
// Token accounts that hold the mint right now (one request): {account, owner, amount}. Token or Token-2022.
async function currentHolderAccounts(rpc,mint){
 const info=await rpc.call('getAccountInfo',[mint,{encoding:'base64',commitment:'finalized'}]);
 const program=info?.value?.owner;if(!program)throw Object.assign(Error('mint not found'),{code:'MINT_NOT_FOUND'});
 const list=await rpc.call('getProgramAccounts',[program,{encoding:'jsonParsed',commitment:'finalized',filters:[{memcmp:{offset:0,bytes:mint}}]}]);
 return(list||[]).map(a=>({account:a.pubkey,owner:a.account?.data?.parsed?.info?.owner,amount:a.account?.data?.parsed?.info?.tokenAmount?.amount})).filter(a=>a.account&&a.amount&&a.amount!=='0');
}
module.exports={Rpc,marketAddresses,signaturesFor,collect,parseAll,TX_VERSION,reportedIndex,currentHolderAccounts};

// Latest produced, finalized slot whose block time is ≤ cutoff (spec §9). Never slides forward.
// f(x) = time(first produced slot ≥ x) ≤ cutoff is monotone (true, then false): binary search the
// last x where f holds; its first produced slot is the answer.
async function findCutoffSlot(rpc,cutoff){
 const head=await rpc.call('getSlot',[{commitment:'finalized'}]),headTime=await rpc.call('getBlockTime',[head]);
 if(headTime<cutoff)return{slot:null,reason:'cutoff_not_finalized',head,headTime};
 const first=async x=>{const b=await rpc.call('getBlocks',[x,Math.min(x+1000,head),{commitment:'finalized'}]);return b.length?b[0]:null;};
 const f=async x=>{const s=await first(x);return s!==null&&await rpc.call('getBlockTime',[s])<=cutoff;};
 let lo=Math.max(0,head-Math.ceil((headTime-cutoff)/0.35)-400),step=2000;
 while(!(await f(lo))){if(lo===0)return{slot:null,reason:'cutoff_before_history',head,headTime};lo=Math.max(0,lo-step);step*=2;}
 let r=head+1;while(r-lo>1){const m=Math.floor((lo+r)/2);if(await f(m))lo=m;else r=m;}
 const slot=await first(lo);return{slot,blockTime:await rpc.call('getBlockTime',[slot]),head,headTime};
}
module.exports.findCutoffSlot=findCutoffSlot;
