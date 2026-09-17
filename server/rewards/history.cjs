'use strict';
const W=require('./wire.cjs'),P=require('./policy.cjs');
// Archive RPC address history complements the all-block mint index. Pagination
// must reach the requested boundary; a provider's truncated history is a hold.
async function walletHistory(rpc,wallet,{cutoffSlot,cutoffTime,maximumPages=100}){
 const until=cutoffTime-P.POLICY.fundingHistorySeconds,signatures=[];let before,finished=false,earliest=false;
 for(let page=0;page<maximumPages;page++){
  const rows=await rpc.call('getSignaturesForAddress',[wallet,{commitment:'finalized',limit:1000,...(before?{before}:{})}]);
  if(!rows.length){earliest=true;finished=true;break;}
  for(const row of rows){if(row.slot>cutoffSlot)continue;if(row.blockTime===null)return{complete:false,reason:'funding_history_time_missing'};if(row.blockTime<until){finished=true;break;}if(!row.err)signatures.push(row);}
  if(finished)break;const next=rows.at(-1).signature;if(next===before)throw Error('History cursor did not advance');before=next;
 }
 if(!finished)return{complete:false,reason:'funding_history_page_limit'};
 const transactions=[];for(const s of signatures){const t=await rpc.call('getTransaction',[s.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);if(!t||!t.meta||t.slot!==s.slot)return{complete:false,reason:'funding_transaction_missing'};transactions.push(t);}
 return{complete:true,startTime:until,firstActivityProven:earliest,firstActivity:earliest&&signatures.length?signatures.at(-1).blockTime:null,throughSlot:cutoffSlot,transactions,digest:W.hash(P.stable(signatures)).toString('hex')};
}
async function newerActivity(rpc,addresses,throughSlot){
 if(addresses.length>128)return{hold:true,reason:'too_many_token_accounts_for_fresh_check'};
 for(const address of new Set(addresses)){const rows=await rpc.call('getSignaturesForAddress',[address,{commitment:'confirmed',limit:1}]);if(rows.some(x=>!x.err&&x.slot>throughSlot))return{hold:true,reason:'newer_activity_needs_finalized_indexing',signature:rows[0].signature};}
 return{hold:false};
}
module.exports={walletHistory,newerActivity};
