'use strict';
// Builds finalized event streams with exactly the shapes emitted by server/rewards/indexer.cjs.
const SOL=10n**9n,CURVE='CurvePDA';
// Minimal builder that emits the same event shapes as server/rewards/indexer.cjs.
function chain({startSlot=100,timeOf=slot=>1000+slot}={}){
 let slot=startSlot,tx=0;const events=[],balances=new Map();let cur;
 const ev=(kind,owner,data,path='0')=>{const e={id:cur.sig+':'+cur.n++,signature:cur.sig,slot:cur.slot,time:cur.time,transactionIndex:cur.index,order:cur.n,eventIndex:0,path,kind,owner,data};cur.events.push(e);return e;};
 const api={
  skipTo(target){slot=target-1;return api;},
  tx(fn,{sameSlot=false}={}){if(!sameSlot)slot++;cur={sig:'sig'+(++tx),slot,time:timeOf(slot),index:tx,n:0,events:[],touched:new Set()};fn(api);
   const accounts=[...cur.touched].map(a=>({account:a,owner:balances.get(a).owner,amount:String(balances.get(a).amount)}));
   if(accounts.length)ev('token_balances',null,{accounts},'post/balances');events.push(...cur.events);return cur.sig;},
  account(account,owner){if(!balances.has(account))balances.set(account,{owner,amount:0n});return account;},
  move(account,delta){const b=balances.get(account);b.amount+=BigInt(delta);cur.touched.add(account);},
  buy(owner,account,qty,{lamports=SOL,fee=10000000n,creatorFee=5000000n,pay=lamports+fee+creatorFee,recipientOwner=owner,recipientAccount=account,venue='pump-curve',vSol=30n*SOL,vTok=1000000n*1000000n}={}){
   api.account(recipientAccount,recipientOwner);
   ev('funding_transfer',owner,{from:owner,to:CURVE,amount:String(pay)},'0/1');
   ev('market_delivery',recipientOwner,{source:'curveATA',destination:recipientAccount,amount:String(qty)},'0/2');
   api.move(recipientAccount,qty);
   ev('purchase_candidate',owner,{venue,quoteAsset:'native-SOL',route:'0',event:{tokenAmount:String(qty),solAmount:String(lamports),fee:String(fee),creatorFee:String(creatorFee),virtualSolReserves:String(vSol),virtualTokenReserves:String(vTok)}},'0/3');
  },
  sell(owner,account,qty,{vSol,vTok}={}){ev('transfer_exit',owner,{source:account,destination:'curveATA',to:CURVE,amount:String(qty)},'0/1');ev('incoming_transfer',CURVE,{from:owner,amount:String(qty)},'0/1');api.move(account,-BigInt(qty));ev('sale',owner,{event:{tokenAmount:String(qty),...(vSol?{virtualSolReserves:String(vSol),virtualTokenReserves:String(vTok)}:{})}},'0/2');},
  transfer(fromOwner,fromAcc,toOwner,toAcc,qty,{delegate}={}){api.account(toAcc,toOwner);
   if(fromOwner===toOwner)ev('same_owner_transfer',fromOwner,{source:fromAcc,destination:toAcc,amount:String(qty)});
   else{ev('transfer_exit',fromOwner,{source:fromAcc,destination:toAcc,to:toOwner,amount:String(qty),delegate});ev('incoming_transfer',toOwner,{from:fromOwner,amount:String(qty)});}
   api.move(fromAcc,-BigInt(qty));api.move(toAcc,qty);},
  burn(owner,acc,qty){ev('burn',owner,{account:acc,amount:String(qty)});api.move(acc,-BigInt(qty));},
  events,
 };return api;
}
module.exports={chain,SOL,CURVE};
