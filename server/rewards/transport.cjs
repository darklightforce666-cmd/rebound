'use strict';
const crypto=require('node:crypto'),bs58=require('bs58');
const {Transaction}=require('@solana/web3.js');
const DB=require('./db.cjs'),P=require('./policy.cjs'),Config=require('./config.cjs');
async function reconcileAttempt(db,connection,attempt,readSettlement){
 const result=(await connection.getSignatureStatuses([attempt.signature],{searchTransactionHistory:true})).value[0];
 const settlement=await readSettlement(attempt.signature);
 if(settlement?.settled){await db.query("UPDATE reward_chain_attempts SET state='finalized',result=$2,updated_at=now() WHERE id=$1",[attempt.id,P.stable(settlement)]);return{state:'finalized',settlement,signature:settlement.signature||attempt.signature};}
 if(result?.confirmationStatus==='finalized'){
  const state=result.err?'failed':'uncertain';await db.query('UPDATE reward_chain_attempts SET state=$2,result=$3,updated_at=now() WHERE id=$1',[attempt.id,state,P.stable(result)]);return{state,signature:attempt.signature};
 }
 const finalizedHeight=await connection.getBlockHeight('finalized');
 if(!result&&finalizedHeight>Number(attempt.last_valid_block_height)&&settlement?.definitivelyUnsettled){await db.query("UPDATE reward_chain_attempts SET state='expired',updated_at=now() WHERE id=$1",[attempt.id]);return{state:'expired'};}
 await db.query("UPDATE reward_chain_attempts SET state='uncertain',updated_at=now() WHERE id=$1",[attempt.id]);return{state:'uncertain',signature:attempt.signature};
}
async function submit({db,connection,cfg,preflight,job,instructions,payer,signers=[],context={},readSettlement,prepare}){
 const prior=(await db.query("SELECT * FROM reward_chain_attempts WHERE job=$1 AND state IN ('prepared','broadcast','uncertain') ORDER BY created_at DESC LIMIT 1",[job])).rows[0];
 if(prior){const state=await reconcileAttempt(db,connection,prior,readSettlement);if(state.state!=='expired'&&state.state!=='failed')return state;return{state:'retry_requires_fresh_check'};}
 const current=await readSettlement();if(current?.settled)return{state:'finalized',settlement:current};
 if(current?.uncertain)return{state:'held',reason:current.reason||'settlement_evidence_unavailable'};
 if(!cfg.enabled)return{state:'dry-run',job,instructions:instructions.length,context};
 Config.requireProduction(preflight,cfg);
 const blockhash=await connection.getLatestBlockhash('confirmed'),tx=prepare?await prepare(blockhash):new Transaction({feePayer:payer.publicKey,...blockhash}).add(...instructions);
 if(!tx.feePayer?.equals(payer.publicKey)||tx.recentBlockhash!==blockhash.blockhash)throw Error('Prepared transaction context mismatch');
 tx.partialSign(...[...new Map([payer,...signers].map(k=>[k.publicKey.toBase58(),k])).values()]);
 const bytes=tx.serialize();if(bytes.length>1232)throw Error('Payment exceeds transaction limit; reservation retained');
 const signature=bs58.encode(tx.signature),id=crypto.randomUUID();
 // Persist signed bytes before broadcast. A process crash never loses the
 // signature needed to resolve an uncertain send. No send is counted as paid.
 await db.query('INSERT INTO reward_chain_attempts(id,job,state,signature,transaction_bytes,last_valid_block_height,context) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,job,'prepared',signature,bytes.toString('base64'),blockhash.lastValidBlockHeight,P.stable(context)]);
 try{const sent=await connection.sendRawTransaction(bytes,{skipPreflight:false,maxRetries:0});if(sent!==signature)throw Error('RPC returned another transaction signature');await db.query("UPDATE reward_chain_attempts SET state='broadcast',updated_at=now() WHERE id=$1",[id]);return{state:'broadcast',signature};}
 catch{await db.query("UPDATE reward_chain_attempts SET state='uncertain',updated_at=now() WHERE id=$1",[id]);return{state:'uncertain',signature};}
}
module.exports={reconcileAttempt,submit};
