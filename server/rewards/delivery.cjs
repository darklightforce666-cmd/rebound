'use strict';
const W=require('./wire.cjs'),P=require('./policy.cjs'),DB=require('./db.cjs'),T=require('./transport.cjs'),Internal=require('./internal.cjs');
async function settledAllocation(connection,program,mint,round,index,wallet){
 const address=W.addresses(program,mint,round,wallet,index).allocation,info=await connection.getAccountInfoAndContext(address,'finalized');
 if(!info.value)return{definitivelyUnsettled:true};if(!info.value.owner.equals(W.pk(program)))throw Error('Allocation owner mismatch');const value=W.decode(info.value.data,'allocation');if(!value.settled)return{definitivelyUnsettled:true,...value};
 const I=require('./indexer.cjs'),bs58=require('bs58');
 for(const s of await connection.getSignaturesForAddress(address,{limit:100},'finalized')){if(s.err)continue;const tx=await connection.getParsedTransaction(s.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx||tx.meta?.err)continue;const found=I.trace(I.plain(tx)).some(i=>i.programId===program&&i.data&&bs58.decode(i.data)[0]===8&&i.accounts?.includes(address.toBase58()));if(found)return{settled:true,...value,slot:s.slot,signature:s.signature};}
 return{uncertain:true,reason:'settlement_transaction_evidence_unavailable'};
}
async function deliver({db,connection,cfg,preflight,payer,mint,round,index,verify=Internal.call}){
 const allocation=(await db.query('SELECT * FROM reward_allocations WHERE mint=$1 AND round_id=$2 AND leaf_index=$3',[mint,round,index])).rows[0];if(!allocation)return{state:'held',reason:'allocation_not_found'};
 const readSettlement=()=>settledAllocation(connection,cfg.program,mint,round,index,allocation.wallet);
 const existing=(await db.query("SELECT * FROM reward_chain_attempts WHERE job=$1 AND state IN ('prepared','broadcast','uncertain')",['pay:'+mint+':'+round+':'+index])).rows[0];
 if(existing){const r=await T.reconcileAttempt(db,connection,existing,readSettlement);if(r.state==='finalized'){
   const posInfo=await connection.getAccountInfo(W.addresses(cfg.program,mint,round,allocation.wallet,index).position,'finalized');const position=W.decode(posInfo.data,'position');
   await DB.settleAllocation(db,{mint,round,index,paid:r.settlement.paid,released:r.settlement.released,signature:r.signature,slot:r.settlement.slot,positionVersion:String(position.version),positionTotals:position,evidence:existing.context});return r;
  }return r;
 }
 if(BigInt(allocation.active)===0n)return{state:'finalized',signature:allocation.settlement_signature};
 const external=await readSettlement();if(external.settled){const posInfo=await connection.getAccountInfo(W.addresses(cfg.program,mint,round,allocation.wallet,index).position,'finalized'),position=W.decode(posInfo.data,'position');await DB.settleAllocation(db,{mint,round,index,paid:external.paid,released:external.released,signature:external.signature,slot:external.slot,positionVersion:String(position.version),positionTotals:position,evidence:{relayer:'external'}});return{state:'finalized',signature:external.signature};}if(external.uncertain)return{state:'held',reason:external.reason};
 const authorization=await verify('/payment',{mint,round,index});
 if(['hold','settled'].includes(authorization.outcome)){
  if(authorization.outcome==='hold')await db.query("UPDATE reward_allocations SET state='held',check_evidence=$4 WHERE mint=$1 AND round_id=$2 AND leaf_index=$3 AND active>0",[mint,round,index,P.stable(authorization)]);
  return{state:authorization.outcome==='hold'?'held':'reconciliation_required',reason:authorization.reason};
 }
 if(authorization.verifier!==cfg.verifier)throw Error('Unexpected verifier signer');
 const a=authorization.authorization;
 if(a.program!==cfg.program||a.mint!==mint||String(a.round)!==String(round)||Number(a.index)!==Number(index)||a.wallet!==allocation.wallet||BigInt(a.maximum)!==BigInt(allocation.maximum))throw Error('Authorization allocation binding mismatch');
 const message=W.paymentMessage(a);if(!message.equals(Buffer.from(authorization.message,'base64')))throw Error('Authorization wire message mismatch');
 const instructions=[W.attest(cfg.verifier,message,Buffer.from(authorization.signature,'base64')),W.settle(cfg.program,a,authorization.tokenAccounts)];
 return T.submit({db,connection,cfg,preflight,job:'pay:'+mint+':'+round+':'+index,instructions,payer,context:{mint,round,index,authorization:a,check:authorization.evidence},readSettlement});
}
module.exports={settledAllocation,deliver};
