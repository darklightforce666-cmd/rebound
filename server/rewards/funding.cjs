'use strict';
const P=require('./policy.cjs'),W=require('./wire.cjs'),H=require('./history.cjs'),I=require('./indexer.cjs'),DB=require('./db.cjs');
const address=k=>typeof k==='string'?k:k.pubkey;
function nativeTransfers(tx){
 const rows=[];
 for(const ins of I.trace(tx))if(address(ins.programId)==='11111111111111111111111111111111'&&ins.parsed?.type==='transfer'){
  const v=ins.parsed.info;if(!Number.isSafeInteger(v.lamports))throw Error('Unsafe funding quantity');
  rows.push({id:W.hash(tx.transaction.signatures[0],ins.path).toString('hex'),from:v.source,to:v.destination,amount:String(v.lamports),time:tx.blockTime,slot:tx.slot,asset:'native-SOL',complete:true,signature:tx.transaction.signatures[0],path:ins.path});
 }return rows;
}
function analyzePurchase(lot,history,services){
 if(!history.complete)return{edges:[],holds:[{purchase:lot.id,reason:history.reason||'funding_history_incomplete'}]};
 const purchase={id:lot.id,wallet:lot.wallet,time:lot.at,cost:lot.cost},transfers=[],running=new Map();let preBalance=null,outflows=0;
 const known=new Map(services.map(s=>[s.address,s]));
 // Conservative attribution: every intervening wallet expense may consume a
 // source's funding first. Only its remaining lower bound can establish a link.
 const ordered=[...history.transactions].sort((a,b)=>a.slot-b.slot||a.transactionIndex-b.transactionIndex);
 for(const tx of ordered){
  const signature=tx.transaction.signatures[0],keys=tx.transaction.message.accountKeys.map(address),index=keys.indexOf(lot.wallet);if(index<0)continue;
  const pre=P.int(tx.meta.preBalances[index]),post=P.int(tx.meta.postBalances[index]);
  if(signature===lot.provenance.signature){
   const beforePurchase=I.trace(tx).filter(ins=>ins.order<Number(lot.provenance.route));
   // Unattributed intra-transaction funding is held, never implicitly treated
   // as independent capital. Supported standalone transfers are fully traced.
   if(nativeTransfers(tx).some(t=>t.to===lot.wallet&&Number(t.path.split('/')[0])<=Number(lot.provenance.route)))return{edges:[],holds:[{purchase:lot.id,reason:'same_transaction_funding_requires_route_attribution'}]};
   preBalance=pre;break;
  }
  if(tx.slot>lot.slot)break;
  const moves=nativeTransfers(tx),incoming=moves.filter(t=>t.to===lot.wallet&&t.time>=lot.at-P.POLICY.fundingWindowSeconds);
  for(const t of incoming){const service=known.get(t.from);t.sourceClassification=service?.classification||'unknown';t.isReward=service?.classification==='rebound-payout';transfers.push(t);running.set(t.from,(running.get(t.from)||0n)+P.int(t.amount));}
  const received=P.sum(moves.filter(t=>t.to===lot.wallet).map(t=>t.amount));
  const spent=pre+received>post?pre+received-post:0n;
  if(spent>0n){outflows++;for(const[k,n]of running)running.set(k,n>spent?n-spent:0n);}
 }
 if(preBalance===null)return{edges:[],holds:[{purchase:lot.id,reason:'purchase_funding_order_unproven'}]};
 const edges=[],holds=[];
 for(const[source,remaining]of running){
  const selected=transfers.filter(t=>t.from===source);let limit=remaining;
  const bounded=[];for(const t of selected){if(!limit)break;const n=P.int(t.amount),use=n<limit?n:limit;bounded.push({...t,amount:String(use),spentByPurchase:lot.id});limit-=use;}
  const independent=preBalance>remaining?preBalance-remaining:0n;
  const result=P.fundingEdges({purchase,transfers:bounded,recipientHistory:{...history,independentFunds:independent,independentOutflows:outflows},services:services.map(s=>({...s,verified:true}))});edges.push(...result.edges);holds.push(...result.holds);
 }
 return{edges,holds,evidence:{historyDigest:history.digest,preBalance,sourceBalances:Object.fromEntries(running),policy:P.POLICY_HASH}};
}
async function refresh({db,rpc,coin,replay,cutoff}){
 const services=(await db.query('SELECT * FROM reward_services WHERE expires_at>now()')).rows;
 // A treasury is exempt only after deriving and matching this deployment's
 // fixed mint treasury, never because an arbitrary sender labels itself one.
 for(const c of (await db.query('SELECT treasury FROM reward_coins WHERE deployment=$1',[coin.deployment])).rows)services.push({address:c.treasury,classification:'rebound-payout',verified:true,evidence:{deployment:coin.deployment,source:'registered-program-PDA'}});
 const results=[];
 for(const wallet of [...new Set(replay.lots.map(l=>l.wallet))]){
  let history=await H.walletHistory(rpc,wallet,{cutoffSlot:cutoff.slot,cutoffTime:cutoff.time});
  if(history.complete){
   // RPC address order only gives slots. Resolve same-slot order using the
   // complete finalized block, including the purchase transaction itself.
   const blocks=new Map();for(const tx of history.transactions){if(!blocks.has(tx.slot))blocks.set(tx.slot,await rpc.call('getBlock',[tx.slot,{encoding:'jsonParsed',transactionDetails:'full',rewards:false,maxSupportedTransactionVersion:0,commitment:'finalized'}]));const block=blocks.get(tx.slot);tx.transactionIndex=block?.transactions.findIndex(t=>t.transaction.signatures[0]===tx.transaction.signatures[0]);if(tx.transactionIndex===undefined||tx.transactionIndex<0){history={complete:false,reason:'funding_block_order_unavailable'};break;}}
  }
  const outputs=[];
  for(const lot of replay.lots.filter(l=>l.wallet===wallet)){
   // Funding at purchase requires its own historical window, even after a
   // position becomes older than the rolling history lookback.
   const prior=(await db.query("SELECT evidence FROM reward_audit WHERE mint=$1 AND wallet=$2 AND kind='purchase_funding' AND evidence->>'purchase'=$3 ORDER BY id DESC LIMIT 1",[coin.mint,wallet,lot.id])).rows[0]?.evidence;
   let result=prior?.complete&&prior.history?analyzePurchase(lot,prior.history,services):null;
   if(!result){let purchaseHistory=history;if(history.complete&&history.startTime>lot.at-P.POLICY.fundingHistorySeconds)purchaseHistory=await H.walletHistory(rpc,wallet,{cutoffSlot:cutoff.slot,cutoffTime:lot.at});
    if(purchaseHistory!==history&&purchaseHistory.complete){const order=new Map(replay.events?.map(e=>[e.signature,e.transactionIndex])||[]);for(const tx of purchaseHistory.transactions){let index=order.get(tx.transaction.signatures[0]);if(index===undefined){const block=await rpc.call('getBlock',[tx.slot,{encoding:'jsonParsed',transactionDetails:'full',rewards:false,maxSupportedTransactionVersion:0,commitment:'finalized'}]);index=block?.transactions.findIndex(t=>t.transaction.signatures[0]===tx.transaction.signatures[0]);}if(index===undefined||index<0){purchaseHistory={complete:false,reason:'funding_block_order_unavailable'};break;}tx.transactionIndex=index;}}
    result=analyzePurchase(lot,purchaseHistory,services);
    await DB.audit(db,'purchase_funding',{purchase:lot.id,complete:purchaseHistory.complete,result,history:purchaseHistory},{mint:coin.mint,wallet,actor:'verifier'});
   }
   for(const edge of [...result.edges,...result.holds]){
    if(!edge.source)continue;const id=W.hash(coin.mint,edge.source,wallet,lot.id,P.POLICY_HASH).toString('hex');
    await db.query('INSERT INTO reward_wallet_links(id,mint,source,recipient,purchase,status,policy_hash,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[id,coin.mint,edge.source,wallet,lot.id,edge.status||'ambiguous',P.POLICY_HASH,P.stable(edge)]);
   }outputs.push({purchase:lot.id,result});
  }
  const complete=history.complete&&outputs.every(o=>!o.result.holds.some(h=>!h.source));
  const evidence={complete,checkedThrough:cutoff.slot,historyDigest:history.digest,policy:P.POLICY_HASH,outputs};await DB.audit(db,'funding_check',evidence,{mint:coin.mint,wallet,actor:'verifier'});results.push({wallet,...evidence});
 }return results;
}
module.exports={nativeTransfers,analyzePurchase,refresh};
