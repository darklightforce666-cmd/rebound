'use strict';
// Durable transaction lifecycle (spec §10.2), V3 edition of transport.cjs:
// 1 intent → 2 validate → 3 blockhash/simulate → 4 sign → 5 PERSIST signed bytes + signature +
// last-valid height BEFORE broadcast → 6 broadcast = `submitted`, never `paid` → 7 reconcile with
// finalized receipts → 8 retry only after proving the old signature can no longer settle.
// Rebroadcasting identical signed bytes is allowed; signing a second payment is not.
const crypto=require('node:crypto'),bs58=require('bs58');
const {Transaction,VersionedTransaction}=require('@solana/web3.js');
const DB=require('./db.cjs'),{stable}=require('./policy.cjs'),X=require('./execution.cjs'),Logs=require('./logs.cjs');
const LIVE="('prepared','broadcast','uncertain')";

async function reconcile(db,connection,attempt,readSettlement){
 const status=(await connection.getSignatureStatuses([attempt.signature],{searchTransactionHistory:true})).value[0];
 const settlement=await readSettlement(attempt.signature);
 if(settlement?.settled){await db.query("UPDATE reward_chain_attempts SET state='finalized',result=$2,finalized_at=now(),finalized_slot=$3,updated_at=now() WHERE id=$1",[attempt.id,stable(settlement),settlement.slot??null]);return{state:'finalized',settlement,signature:settlement.signature||attempt.signature};}
 if(status?.confirmationStatus==='finalized'){const state=status.err?'failed':'uncertain';await db.query('UPDATE reward_chain_attempts SET state=$2,result=$3,updated_at=now() WHERE id=$1',[attempt.id,state,stable(status)]);return{state,signature:attempt.signature};}
 const height=await connection.getBlockHeight('finalized');
 if(!status&&height>Number(attempt.last_valid_block_height)&&settlement?.definitivelyUnsettled){await db.query("UPDATE reward_chain_attempts SET state='expired',updated_at=now() WHERE id=$1",[attempt.id]);return{state:'expired'};}
 // Still possibly landing: rebroadcast the SAME signed bytes (never re-sign).
 if(!status&&height<=Number(attempt.last_valid_block_height)){try{await connection.sendRawTransaction(Buffer.from(attempt.transaction_bytes,'base64'),{skipPreflight:true,maxRetries:0});}catch{}}
 await db.query("UPDATE reward_chain_attempts SET state='uncertain',updated_at=now() WHERE id=$1",[attempt.id]);return{state:'uncertain',signature:attempt.signature};
}

async function persistAndBroadcast(db,connection,{job,kind,mint,signerRole,intentId,bytes,signature,lastValidBlockHeight,context}){
 const id=crypto.randomUUID();
 await db.query('INSERT INTO reward_chain_attempts(id,job,state,signature,transaction_bytes,last_valid_block_height,context,intent_id,kind,mint,signer_role) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
  [id,job,'prepared',signature,Buffer.from(bytes).toString('base64'),lastValidBlockHeight,stable(context||{}),intentId||null,kind||null,mint||null,signerRole||null]);
 try{const sent=await connection.sendRawTransaction(Buffer.from(bytes),{skipPreflight:false,maxRetries:0});if(sent!==signature)throw Error('RPC returned another signature');
  await db.query("UPDATE reward_chain_attempts SET state='broadcast',submitted_at=now(),updated_at=now() WHERE id=$1",[id]);return{state:'submitted',signature,attempt:id};}
 catch(e){await db.query("UPDATE reward_chain_attempts SET state='uncertain',submitted_at=now(),error_code=$2,updated_at=now() WHERE id=$1",[id,/simulation|preflight/i.test(e.message)?'SIMULATION_FAILED':'TRANSACTION_UNCERTAIN']);return{state:'uncertain',signature,attempt:id};}
}

/**
 * Sign and submit a server-built transaction under the execution gate.
 * @param a.readSettlement async (signature?) → {settled, slot?} | {definitivelyUnsettled} | {uncertain, reason}
 * @param a.spend {namespace, mint, recipients, lamports, fees, cycleId, kind}
 * @param a.cosign async (tx: Transaction) → void  (e.g. independent verifier partial signature)
 */
async function submit(a){
 const {db,connection,job,feePayer,signers=[],instructions,readSettlement,spend,cosign}=a;
 const prior=(await db.query(`SELECT * FROM reward_chain_attempts WHERE job=$1 AND state IN ${LIVE} ORDER BY created_at DESC LIMIT 1`,[job])).rows[0];
 if(prior){const r=await reconcile(db,connection,prior,readSettlement);if(r.state!=='expired'&&r.state!=='failed')return r;}
 const current=await readSettlement();if(current?.settled)return{state:'finalized',settlement:current};
 if(current?.uncertain)return{state:'held',reason:current.reason||'settlement_evidence_unavailable'};
 try{await DB.transaction(db,tx=>X.authorize(tx,spend));}
 catch(e){if(e instanceof X.ExecutionBlocked)return{state:e.code==='DRY_RUN'?'dry_run':'blocked',code:e.code,reason:e.message};throw e;}
 const bh=await connection.getLatestBlockhash('confirmed');
 const tx=new Transaction({feePayer:feePayer.publicKey,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(...instructions);
 const sim=await connection.simulateTransaction(tx,[feePayer,...signers]).catch(()=>null);   // also signs; re-signed below with the same key
 if(sim?.value?.err){await Logs.log(db,{severity:'warn',component:'transport',eventType:'simulation_failed',mint:spend?.mint,jobId:job,message:'Simulation rejected; nothing submitted',errorCode:'SIMULATION_FAILED',metadata:{err:sim.value.err,logs:(sim.value.logs||[]).slice(-8)}});return{state:'held',reason:'simulation_failed',err:sim.value.err};}
 const t2=new Transaction({feePayer:feePayer.publicKey,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(...instructions);
 t2.partialSign(...[...new Map([feePayer,...signers].map(k=>[k.publicKey.toBase58(),k])).values()]);
 if(cosign)await cosign(t2);
 const bytes=t2.serialize();if(bytes.length>1232)throw Object.assign(Error('Transaction exceeds packet limit'),{code:'TRANSACTION_TOO_LARGE'});
 return persistAndBroadcast(db,connection,{job,kind:a.kind,mint:spend?.mint,signerRole:a.signerRole,intentId:a.intentId,bytes,signature:bs58.encode(t2.signature),lastValidBlockHeight:bh.lastValidBlockHeight,context:a.context});
}

// Compare a user-signed transaction against the stored intent (exact instructions, signer).
function matchesIntent(tx,{instructions,signer,blockhash}){
 const msg=tx.compileMessage?tx.compileMessage():null;if(!msg)return false;
 if(!tx.feePayer||tx.feePayer.toBase58()!==signer)return false;
 if(blockhash&&tx.recentBlockhash!==blockhash)return false;   // the validity window we persisted
 const got=tx.instructions.map(i=>({p:i.programId.toBase58(),k:i.keys.map(k=>k.pubkey.toBase58()+(k.isWritable?'w':'')+(k.isSigner?'s':'')).join(','),d:Buffer.from(i.data).toString('hex')}));
 const want=instructions.map(i=>({p:i.programId.toBase58(),k:i.keys.map(k=>k.pubkey.toBase58()+(k.isWritable?'w':'')+(k.isSigner?'s':'')).join(','),d:Buffer.from(i.data).toString('hex')}));
 // Compute-budget instructions added by wallets are tolerated; nothing else.
 const cb='ComputeBudget111111111111111111111111111111';const core=got.filter(x=>x.p!==cb);
 return core.length===want.length&&core.every((x,i)=>x.p===want[i].p&&x.k===want[i].k&&x.d===want[i].d)&&tx.verifySignatures(true);
}
// Manual mode: the dev wallet signed the exact prepared intent in the browser.
async function submitSigned({db,connection,job,intent,serialized,readSettlement,spend}){
 let tx;try{tx=Transaction.from(Buffer.from(serialized,'base64'));}catch{throw Object.assign(Error('Unsupported transaction encoding'),{code:'INVALID_TRANSACTION'});}
 if(!matchesIntent(tx,intent))throw Object.assign(Error('Signed transaction does not match the prepared funding plan'),{code:'FORBIDDEN'});
 const prior=(await db.query(`SELECT * FROM reward_chain_attempts WHERE job=$1 AND state IN ${LIVE} LIMIT 1`,[job])).rows[0];
 if(prior){const r=await reconcile(db,connection,prior,readSettlement);if(r.state!=='expired'&&r.state!=='failed')return r;}
 const current=await readSettlement();if(current?.settled)return{state:'finalized',settlement:current};
 try{await DB.transaction(db,t=>X.authorize(t,spend));}catch(e){if(e instanceof X.ExecutionBlocked)return{state:e.code==='DRY_RUN'?'dry_run':'blocked',code:e.code,reason:e.message};throw e;}
 const height=intent.lastValidBlockHeight;if(!height)throw Object.assign(Error('Funding plan has no validity window'),{code:'INVALID_TRANSACTION'});
 return persistAndBroadcast(db,connection,{job,kind:'primary_funding',mint:spend?.mint,signerRole:'primary_dev',intentId:intent.id,bytes:tx.serialize(),signature:bs58.encode(tx.signature),lastValidBlockHeight:height,context:{manual:true}});
}
module.exports={reconcile,submit,submitSigned,matchesIntent,persistAndBroadcast};
