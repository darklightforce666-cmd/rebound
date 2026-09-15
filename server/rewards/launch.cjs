'use strict';
const crypto=require('node:crypto'),bs58=require('bs58');
const {Transaction,SystemProgram,ComputeBudgetProgram}=require('@solana/web3.js');
const P=require('./policy.cjs'),W=require('./wire.cjs'),Pump=require('./pump.cjs'),DB=require('./db.cjs'),C=require('./config.cjs');
const INTAKE_SETUP_LAMPORTS=50000000;
async function prepare({db,connection,cfg,wallet,payload}){
 C.requireProduction(await C.preflight(connection,db,cfg),cfg);W.pk(payload.mint);
 if(await connection.getAccountInfo(W.pk(payload.mint),'finalized'))throw Error('Mint already exists. Existing coins require authority and historical fee review.');
 const metadata=await require('./metadata.cjs').read(payload.metadataHash);if(!metadata||metadata.metadata.mime!=='application/json')throw Error('Persistent metadata unavailable');
 const data=JSON.parse(Buffer.from(metadata.data)),uri=cfg.origin+'/.netlify/functions/rewards?action=metadata&hash='+payload.metadataHash;
 const prepared=await Pump.prepareLaunch({program:cfg.program,mint:payload.mint,user:wallet,name:data.name,symbol:data.symbol,uri});
 const hash=W.hash(P.stable({wallet,mint:payload.mint,metadataHash:payload.metadataHash,policy:P.POLICY_HASH})).toString('hex'),id=crypto.randomUUID();
 await DB.transaction(db,async tx=>{
  const deployment=(await tx.query('SELECT id FROM reward_deployments WHERE program=$1',[cfg.program])).rows[0];if(!deployment)throw Error('Deployment unavailable');
  await tx.query("INSERT INTO reward_launch_attempts(id,mint,wallet,state,request_hash,metadata_uri,metadata_hash,steps) VALUES($1,$2,$3,'prepared',$4,$5,$6,$7) ON CONFLICT(wallet,request_hash) DO NOTHING",[id,payload.mint,wallet,hash,uri,payload.metadataHash,P.stable({name:data.name,symbol:data.symbol,transactions:[]})]);
  await tx.query("INSERT INTO reward_coins(mint,deployment,launcher,intake,treasury,sharing_config,policy_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,'preparing') ON CONFLICT DO NOTHING",[payload.mint,deployment.id,wallet,prepared.addresses.intake.toBase58(),prepared.addresses.coin.toBase58(),Pump.SDK.feeSharingConfigPda(W.pk(payload.mint)).toBase58(),P.POLICY_HASH]);await tx.query('INSERT INTO reward_accounts(mint) VALUES($1) ON CONFLICT DO NOTHING',[payload.mint]);
 });
 return{attempt:(await db.query('SELECT id FROM reward_launch_attempts WHERE wallet=$1 AND request_hash=$2',[wallet,hash])).rows[0].id,mint:payload.mint,initialCreator:prepared.initialCreator,intakeSetupLamports:String(INTAKE_SETUP_LAMPORTS),note:'The 0.05 SOL setup deposit pays fee-configuration rent and stays separate from creator-fee revenue. Wallet also pays Pump creation and transaction costs.'};
}
async function next({db,connection,cfg,wallet,payload}){
 C.requireProduction(await C.preflight(connection,db,cfg),cfg);
 const row=(await db.query('SELECT * FROM reward_launch_attempts WHERE id=$1 AND wallet=$2',[payload.attempt,wallet])).rows[0];if(!row)throw Error('Launch attempt not found');
 const a=W.addresses(cfg.program,row.mint),coin=await connection.getAccountInfo(a.coin,'finalized'),mint=await connection.getAccountInfo(W.pk(row.mint),'finalized');
 // An unresolved signed transaction is reconciled before a new blockhash is
 // offered. Returning here never asks the wallet to unknowingly pay twice.
 for(const attempt of row.steps.transactions||[]){if(attempt.state!=='submitted')continue;const status=(await connection.getSignatureStatuses([attempt.signature],{searchTransactionHistory:true})).value[0];if(status?.confirmationStatus==='finalized'){attempt.state=status.err?'failed':'finalized';if(!status.err){attempt.slot=status.slot;if(attempt.step==='create')await db.query('UPDATE reward_coins SET launch_slot=$2 WHERE mint=$1',[row.mint,status.slot]);}}else if(!status&&await connection.getBlockHeight('finalized')>attempt.lastValidBlockHeight)attempt.state='expired';else return{state:'confirming',signature:attempt.signature,attempt:row.id};}
 await db.query('UPDATE reward_launch_attempts SET steps=$2,updated_at=now() WHERE id=$1',[row.id,P.stable(row.steps)]);
 let instructions,step;
 if(!coin&&!mint){step='create';const p=await Pump.prepareLaunch({program:cfg.program,mint:row.mint,user:wallet,name:row.steps.name,symbol:row.steps.symbol,uri:row.metadata_uri});instructions=[...p.instructions,SystemProgram.transfer({fromPubkey:W.pk(wallet),toPubkey:a.intake,lamports:INTAKE_SETUP_LAMPORTS})];}
 else if(!coin||!mint)throw Error('Partial launch accounts require review');
 else{
  const state=W.decode(coin.data,'coin');if(state.launcher!==wallet||state.mint!==row.mint)throw Error('Launch account mismatch');
  const sharing=await connection.getAccountInfo(Pump.SDK.feeSharingConfigPda(W.pk(row.mint)),'finalized');
  const curveInfo=await connection.getAccountInfo(Pump.SDK.bondingCurvePda(W.pk(row.mint)),'finalized');if(!curveInfo)throw Error('Pump curve unavailable');const curve=Pump.sdk.decodeBondingCurve(curveInfo);
  const stages=await Pump.sharingSteps(cfg.program,row.mint,curve.complete?Pump.SDK.canonicalPumpPoolPda(W.pk(row.mint)):null);
  if(!sharing){step='sharing';instructions=[stages.create];}
  else if(!Pump.sdk.decodeSharingConfig(sharing).adminRevoked){step='lock';instructions=[stages.lock];}
  else{const routing=await Pump.verifyRouting(connection,cfg.program,row.mint);if(!state.active){step='activate';instructions=[stages.activate];}else{
   const evidence={verifiedSlot:routing.slot,activationSlot:String(state.activationSlot),intake:a.intake.toBase58(),sharing:Pump.SDK.feeSharingConfigPda(W.pk(row.mint)).toBase58(),regularCreatorFees:true};
   await db.query("UPDATE reward_coins SET status='active',activation_slot=$2,activation_evidence=$3,current_creator=sharing_config,blocked_reason=null WHERE mint=$1 AND launch_slot IS NOT NULL",[row.mint,String(state.activationSlot),P.stable(evidence)]);await db.query("UPDATE reward_launch_attempts SET state='active',evidence=evidence||$2::jsonb,updated_at=now() WHERE id=$1",[row.id,P.stable([evidence])]);return{state:'active',mint:row.mint,treasury:a.coin.toBase58(),evidence};
  }}
 }
 const blockhash=await connection.getLatestBlockhash('confirmed'),built=Pump.transaction([ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),...instructions],wallet,blockhash.blockhash);
 const transaction=built.tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),messageHash=W.hash(built.tx.serializeMessage()).toString('hex');
 row.steps.pending={step,transaction,messageHash,lastValidBlockHeight:blockhash.lastValidBlockHeight};await db.query("UPDATE reward_launch_attempts SET steps=$2,state='awaiting_wallet',updated_at=now() WHERE id=$1",[row.id,P.stable(row.steps)]);
 return{attempt:row.id,state:'awaiting_wallet',step,transaction,mint:row.mint,bytes:built.bytes,lastValidBlockHeight:blockhash.lastValidBlockHeight};
}
async function submit({db,connection,cfg,wallet,payload}){
 C.requireProduction(await C.preflight(connection,db,cfg),cfg);const row=(await db.query('SELECT * FROM reward_launch_attempts WHERE id=$1 AND wallet=$2',[payload.attempt,wallet])).rows[0],pending=row?.steps?.pending;if(!pending)throw Error('Prepare the launch transaction first');
 const tx=Transaction.from(Buffer.from(payload.transaction,'base64'));if(!tx.verifySignatures()||!tx.feePayer.equals(W.pk(wallet))||W.hash(tx.serializeMessage()).toString('hex')!==pending.messageHash||tx.serialize().length>1232)throw Error('Signed launch differs from prepared request');
 if(await connection.getBlockHeight('finalized')>pending.lastValidBlockHeight)throw Error('Launch transaction expired; prepare it again');
 const signature=bs58.encode(tx.signature);row.steps.transactions.push({...pending,signature,state:'submitted'});delete row.steps.pending;
 await db.query("UPDATE reward_launch_attempts SET steps=$2,state='confirming',updated_at=now() WHERE id=$1",[row.id,P.stable(row.steps)]);
 try{await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:0});}catch{/* Persisted signature is reconciled before retry. */}
 return{state:'confirming',signature,attempt:row.id};
}
module.exports={INTAKE_SETUP_LAMPORTS,prepare,next,submit};
