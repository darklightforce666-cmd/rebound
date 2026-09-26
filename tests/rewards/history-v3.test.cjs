'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../../server/rewards/history-v3.cjs');
// Fake RPC: produced slots with ~0.4 s spacing, skipped slots every 7th, head at 50000.
function fakeRpc({head=50000,skip=s=>s%7===3,timeOf=s=>1_000_000+Math.floor(s*0.4)}={}){
 const calls={};return{calls,async call(m,p){calls[m]=(calls[m]||0)+1;
  if(m==='getSlot')return head;
  if(m==='getBlockTime'){if(skip(p[0]))throw Object.assign(Error('skipped'),{code:'RPC_ERROR'});return timeOf(p[0]);}
  if(m==='getBlocks'){const out=[];for(let s=p[0];s<=p[1];s++)if(!skip(s))out.push(s);return out;}
  throw Error('unexpected '+m);}};
}
test('cutoff slot is the latest produced finalized slot with block time ≤ cutoff (skipped slots handled)',async()=>{
 const rpc=fakeRpc(),timeOf=s=>1_000_000+Math.floor(s*0.4);
 for(const cutoff of [1_000_000+10000,1_000_000+19999,1_000_000+1234]){
  const r=await H.findCutoffSlot(rpc,cutoff);assert.ok(timeOf(r.slot)<=cutoff);
  let next=r.slot+1;while(next%7===3)next++;assert.ok(timeOf(next)>cutoff,'next produced slot must be after the cutoff');
 }
 assert.equal((await H.findCutoffSlot(fakeRpc(),1_000_000+30000)).reason,'cutoff_not_finalized');
});
test('signature paging reports incompleteness at the page limit instead of truncating silently',async()=>{
 const rpc={async call(m,p){return Array.from({length:p[1].limit},(_,i)=>({signature:'s'+i+(p[1].before||'')}));}};
 const r=await H.signaturesFor(rpc,'Addr',{maxPages:2,pageSize:5});assert.equal(r.complete,false);assert.equal(r.reason,'signature_page_limit');assert.equal(r.signatures.length,10);
});
test('mint inspection accepts plain SPL/Token-2022 metadata mints and rejects fee/hook/delegate extensions',()=>{
 const M=require('../../server/rewards/mint-v3.cjs');
 const mint=(owner,extensions)=>({owner,data:{parsed:{type:'mint',info:{decimals:6,supply:'1000',mintAuthority:null,freezeAuthority:null,extensions}}}});
 assert.equal(M.inspect(mint(M.TOKEN)).ok,true);assert.equal(M.inspect(mint(M.TOKEN_2022,[{extension:'metadataPointer'},{extension:'tokenMetadata'}])).ok,true);
 assert.deepEqual(M.inspect(mint(M.TOKEN_2022,[{extension:'transferFeeConfig',state:{newerTransferFee:{transferFeeBasisPoints:50}}}])).blockers,['transfer_fee']);
 assert.deepEqual(M.inspect(mint(M.TOKEN_2022,[{extension:'permanentDelegate',state:{delegate:'X'}}])).blockers,['unsupported_extension:permanentDelegate']);
 assert.equal(M.inspect(mint(M.TOKEN_2022,[{extension:'transferHook',state:{programId:'P'}}])).ok,false);
 assert.equal(M.inspect(null).reason,'MINT_INVALID');assert.equal(M.inspect({owner:'Other',data:{}}).reason,'MINT_INVALID');
});
