'use strict';
// Third-party launch journey (spec §13) — resumable, idempotent, chain-evidenced.
//   draft → awaiting_creation_signature → creation_submitted → created_pending_activation
//   → activating → active                      (failed_action_required on a hard mismatch)
// * The mint key is generated in the user's browser (ephemeral) and never reaches the server; the
//   server builds the exact transactions, the wallet and the mint key sign them, the server verifies
//   them byte-for-byte against the stored intent, persists the signed bytes, then broadcasts.
// * The mint and launch time are persisted only after the creation transaction finalized and the
//   chain shows the curve with the intake PDA as creator and the REBOUND coin account.
// * Rewards are `active` only after routing is verified on chain (PumpV3.verifyRouting). Closing the
//   browser or rejecting a signature leaves `created_pending_activation`; "Resume setup" rebuilds only
//   the steps the chain shows as missing. A creation that can still land is never replaced.
const crypto=require('node:crypto'),bs58=require('bs58');
const {Transaction,TransactionInstruction,PublicKey,VersionedTransaction,TransactionMessage}=require('@solana/web3.js');
const DB=require('./db.cjs'),W3=require('./wire-v3.cjs'),PV=require('./pump-v3.cjs'),T=require('./transport-v3.cjs'),P3=require('./policy-v3.cjs'),Logs=require('./logs.cjs'),{stable}=require('./policy.cjs');

const fail=(code,message,status=400)=>{throw Object.assign(Error(message),{code,status});};
const ixJson=ix=>({programId:ix.programId.toBase58(),keys:ix.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),data:Buffer.from(ix.data).toString('base64')});
const ixFrom=j=>new TransactionInstruction({programId:new PublicKey(j.programId),keys:j.keys.map(k=>({pubkey:new PublicKey(k.pubkey),isSigner:k.isSigner,isWritable:k.isWritable})),data:Buffer.from(j.data,'base64')});
const unsigned=(ixs,payer,bh)=>new Transaction({feePayer:new PublicKey(payer),blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(...ixs).serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');

async function attempt(db,id,userId){const a=(await db.query('SELECT * FROM reward_launch_attempts WHERE id=$1',[id])).rows[0];if(!a||a.user_id!==userId)fail('NOT_FOUND','Launch not found',404);return a;}
async function setAttempt(db,id,state,fields={},activation){const cols=Object.keys(fields);
 await db.query(`UPDATE reward_launch_attempts SET state=$2${activation?`,activation_state='${activation}'`:''}${cols.map((c,i)=>`,${c}=$${i+3}`).join('')},updated_at=now() WHERE id=$1`,[id,state,...Object.values(fields)]);}

/** Launches are user-signed, but still follow the namespace's execution mode (no public production in a test). */
async function launchAllowed(db,namespace,wallet){
 const p=(await db.query('SELECT * FROM reward_platform WHERE namespace=$1',[namespace])).rows[0];
 if(!p)fail('SETUP_REQUIRED','Launches are not configured yet',503);if(p.paused)fail('PAUSED','Launches are paused',503);
 const ceiling=require('./execution.cjs').ceiling();const RANK={dry_run:0,mainnet_test:1,production:2};const mode=RANK[p.execution_mode]<=RANK[ceiling]?p.execution_mode:ceiling;
 if(mode==='dry_run')fail('DRY_RUN','Launches are disabled in dry run. Nothing was submitted.',409);
 if(namespace==='production'&&mode!=='production')fail('NAMESPACE','Production launches are not enabled',409);
 if(mode==='mainnet_test'&&!p.test_allowlist_wallets.includes(wallet))fail('TEST_WALLET_NOT_ALLOWED','This wallet is not on the private test allowlist',403);
 return mode;
}

/** 1. Draft (idempotent per user + key). Metadata must already be stored immutably (metadata-upload). */
async function draft(ports,{session,wallet,idempotencyKey,metadataHash,name,symbol,initialBuyLamports=0n,namespace='mainnet_test'}){
 const {db}=ports;if(!(session.reboundWallets||session.wallets).includes(wallet))fail('FORBIDDEN','Connect and verify this wallet first',403);
 if(!/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey||''))fail('INVALID_BODY','Invalid idempotency key');
 const buy=BigInt(initialBuyLamports||0);if(buy<0n||buy>100n*10n**9n)fail('INVALID_AMOUNT','Initial buy out of range');
 PV.metadata({name,symbol,uri:'https://x'});
 const existing=(await db.query('SELECT * FROM reward_launch_attempts WHERE user_id=$1 AND idempotency_key=$2',[session.userId,idempotencyKey])).rows[0];if(existing)return existing;
 await launchAllowed(db,namespace,wallet);
 const asset=(await db.query("SELECT * FROM reward_assets WHERE hash=$1 AND kind='metadata'",[metadataHash])).rows[0];if(!asset)fail('METADATA_MISSING','Upload the token image and details first');
 const meta=ports.readMetadata?await ports.readMetadata(metadataHash):null;
 if(meta&&(meta.data?.name!==name||meta.data?.symbol!==symbol))fail('METADATA_MISMATCH','Name/ticker differ from the uploaded metadata');
 const plat=(await db.query('SELECT policy_version,primary_mint FROM reward_platform WHERE namespace=$1',[namespace])).rows[0];
 if(!plat.primary_mint)fail('SETUP_REQUIRED','The REBOUND primary token is not configured yet; launches are closed',503);
 const id=crypto.randomUUID(),request=P3.canonicalHash({wallet,metadataHash,name,symbol,buy:String(buy),namespace,idempotencyKey});
 await db.query(`INSERT INTO reward_launch_attempts(id,wallet,state,request_hash,metadata_uri,metadata_hash,user_id,idempotency_key,namespace,name,symbol,image_uri,initial_buy_lamports,primary_target_mint,policy_version)
  VALUES($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,wallet,request,asset.public_url,metadataHash,session.userId,idempotencyKey,namespace,name,symbol,meta?.data?.image||null,String(buy),plat.primary_mint,plat.policy_version]);
 return(await db.query('SELECT * FROM reward_launch_attempts WHERE id=$1',[id])).rows[0];
}

async function simulate(connection,ixs,payer){
 const {blockhash}=await connection.getLatestBlockhash('confirmed');
 const v=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(payer),recentBlockhash:blockhash,instructions:ixs}).compileToLegacyMessage());
 const r=await connection.simulateTransaction(v,{sigVerify:false,replaceRecentBlockhash:true});return r.value;
}

/** 2. Exact creation transaction(s) + disclosure. `mint` is the browser's ephemeral mint public key. */
async function prepare(ports,{session,attemptId,mint}){
 const {db,connection,program}=ports;const a=await attempt(db,attemptId,session.userId);
 if(!['draft','awaiting_creation_signature'].includes(a.state))fail('LAUNCH_STATE',`Launch is ${a.state}`,409);
 try{mint=new PublicKey(mint).toBase58();}catch{fail('MINT_INVALID','Invalid mint public key');}
 if(await connection.getAccountInfo(new PublicKey(mint)))fail('MINT_EXISTS','That mint address is already in use; generate a new one');
 await launchAllowed(db,a.namespace,a.wallet);
 // A previous signed creation that could still land blocks a new one (no duplicate token).
 const live=(await db.query(`SELECT * FROM reward_chain_attempts WHERE job LIKE $1 AND state IN ${T.LIVE}`,[`launch:${a.id}:%`])).rows[0];
 if(live){const r=await T.reconcile(db,connection,live,async sig=>statusSettled(connection,sig));if(r.state!=='expired'&&r.state!=='failed')fail('LAUNCH_PENDING','The signed creation may still land; wait for it',409);}
 const [gInfo,dInfo]=await connection.getMultipleAccountsInfo([PV.SDK.GLOBAL_PDA,W3.addresses(program).deployment]);
 const global=PV.sdk.decodeGlobal(gInfo),dep=W3.decode('deployment',dInfo.data);
 if(dep.paused)fail('PAUSED','REBOUND is paused',503);
 if(dep.targetMint!==a.primary_target_mint)fail('SETUP_REQUIRED','The on-chain buyback target differs from the configured primary token',503);
 const l=await PV.launch({program,mint,user:a.wallet,name:a.name,symbol:a.symbol,uri:a.metadata_uri,initialBuyLamports:BigInt(a.initial_buy_lamports),global});
 const sim=await simulate(connection,l.transactions[0],a.wallet);
 if(sim.err)fail('SIMULATION_FAILED','The creation transaction would fail on chain; nothing was signed ('+String(sim.err).slice(0,120)+')',422);
 const bh=await connection.getLatestBlockhash('confirmed');
 const body={mint,transactions:l.transactions.map(ixs=>ixs.map(ixJson)),signers:l.signers,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight,intake:l.initialCreator};
 await db.query("INSERT INTO reward_intents(id,kind,mint,job,namespace,body,body_hash,amount_lamports,signer_role,state) VALUES($1,'launch',$2,$3,$4,$5,$6,$7,'creator','awaiting_signature') ON CONFLICT(kind,job) DO UPDATE SET body=EXCLUDED.body,body_hash=EXCLUDED.body_hash,mint=EXCLUDED.mint,state='awaiting_signature',updated_at=now()",
  [crypto.randomUUID(),mint,`launch:${a.id}`,a.namespace,stable(body),P3.canonicalHash(body),String(a.initial_buy_lamports)]);
 await setAttempt(db,a.id,'awaiting_creation_signature',{intake:l.initialCreator,steps:stable([{name:'create',transactions:l.transactions.length}])});
 const rentCoin=await connection.getMinimumBalanceForRentExemption(384);
 return{attemptId:a.id,mint,transactions:l.transactions.map(ixs=>unsigned(ixs,a.wallet,bh)),signers:l.signers,
  disclosure:{creatorWallet:a.wallet,commissionTreasury:l.initialCreator,feeRouting:'All creator fees of this token go to its own program-controlled treasury from the first trade, then are split once: 85 % to holders\' loss compensation, 15 % to buy and burn the REBOUND primary token.',
   primaryBurnTarget:dep.targetMint,policy:{version:a.policy_version,hash:P3.hashOf(P3.policy(a.policy_version)),cycleSeconds:P3.policy(a.policy_version).cycleSeconds,cutoffLeadSeconds:P3.policy(a.policy_version).cutoffLeadSeconds,lossUnit:'USD'},
   costs:{reboundCoinRentLamports:rentCoin,initialBuyLamports:String(a.initial_buy_lamports),initialBuyQuote:l.initialBuy?{expectedOut:String(l.initialBuy.expectedOut),minOut:String(l.initialBuy.minOut)}:null,networkFeeLamports:5000*(l.transactions.length+1)},
   steps:l.transactions.length>1?['Create token','Initial buy']:['Create token'],irreversible:['The token\'s creator-fee destination is fixed to its REBOUND treasury.']}};
}
async function statusSettled(connection,sig){if(!sig)return{definitivelyUnsettled:true};const s=(await connection.getSignatureStatuses([sig],{searchTransactionHistory:true})).value[0];
 return s&&s.confirmationStatus==='finalized'&&!s.err?{settled:true,signature:sig,slot:s.slot}:{definitivelyUnsettled:!s};}

/** 3. Signed creation (index 0) or initial buy (index 1): verified against the intent, persisted, broadcast. */
async function submit(ports,{session,attemptId,index=0,signedTransaction}){
 const {db,connection}=ports;const a=await attempt(db,attemptId,session.userId);
 if(!['awaiting_creation_signature','creation_submitted','created_pending_activation'].includes(a.state))fail('LAUNCH_STATE',`Launch is ${a.state}`,409);
 const intent=(await db.query("SELECT * FROM reward_intents WHERE kind='launch' AND job=$1",[`launch:${a.id}`])).rows[0];if(!intent)fail('PLAN_STALE','Prepare the launch first',409);
 const body=intent.body,ixs=body.transactions[index];if(!ixs)fail('INVALID_BODY','Unknown transaction');
 if(index>0&&a.state==='awaiting_creation_signature')fail('LAUNCH_STATE','Submit the creation first',409);
 let tx;try{tx=Transaction.from(Buffer.from(signedTransaction,'base64'));}catch{fail('INVALID_TRANSACTION','Unsupported transaction encoding');}
 if(!T.matchesIntent(tx,{instructions:ixs.map(ixFrom),signer:a.wallet,blockhash:body.blockhash}))fail('FORBIDDEN','Signed transaction does not match the prepared launch',403);
 await launchAllowed(db,a.namespace,a.wallet);
 const r=await T.persistAndBroadcast(db,connection,{job:`launch:${a.id}:${index}`,kind:'launch',mint:body.mint,signerRole:'creator',intentId:intent.id,bytes:tx.serialize(),signature:bs58.encode(tx.signature),lastValidBlockHeight:body.lastValidBlockHeight,context:{index}});
 if(index===0){await setAttempt(db,a.id,'creation_submitted',{mint:body.mint});await Logs.log(db,{component:'launch',eventType:'creation_submitted',mint:body.mint,message:'Token creation signed and submitted; waiting for finality',metadata:{signature:r.signature}});}
 return{state:r.state,signature:r.signature};
}

/** 4. Reconcile with the chain; persist the coin only after finalized evidence. */
async function status(ports,{session,attemptId}){
 const {db,connection,program}=ports;let a=await attempt(db,attemptId,session.userId);
 if(a.state==='creation_submitted'){
  const at=(await db.query("SELECT * FROM reward_chain_attempts WHERE job=$1 ORDER BY created_at DESC LIMIT 1",[`launch:${a.id}:0`])).rows[0];
  const r=at?(['finalized'].includes(at.state)?{state:'finalized',signature:at.signature}:await T.reconcile(db,connection,at,async sig=>statusSettled(connection,sig))):{state:'expired'};
  if(r.state==='expired'||r.state==='failed'){await setAttempt(db,a.id,'draft',{mint:null});await Logs.log(db,{severity:'warn',component:'launch',eventType:'creation_expired',message:'Token creation did not land; no token exists. Prepare it again.'});}
  else if(r.state==='finalized')await recordCreation(ports,a,at.signature);
  a=await attempt(db,attemptId,session.userId);
 }
 if(['created_pending_activation','activating'].includes(a.state)){
  const v=await PV.verifyRouting(connection,program,a.mint).catch(()=>null);
  if(v)await recordActivation(ports,a,v);
  a=await attempt(db,attemptId,session.userId);
 }
 return{attemptId:a.id,state:a.state,activationState:a.activation_state,mint:a.mint,intake:a.intake};
}
async function recordCreation(ports,a,signature){
 const {db,connection,program}=ports,mint=new PublicKey(a.mint),addr=W3.addresses(program,mint);
 const [m,bc,coin]=await connection.getMultipleAccountsInfo([mint,PV.SDK.bondingCurvePda(mint),addr.coin],'finalized');
 if(!m||!bc||!coin)return;   // not yet visible at finalized commitment
 const curve=PV.sdk.decodeBondingCurve(bc),c=W3.decode('coin',coin.data);
 if(!curve.creator.equals(addr.intake)&&!curve.creator.equals(PV.SDK.feeSharingConfigPda(mint))){await setAttempt(db,a.id,'failed_action_required',{},'failed_action_required');return;}
 PV.regular(curve);
 await DB.transaction(db,async t=>{
  await t.query(`INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version,intake,creator_wallet,creator_user,name,symbol,image_uri,metadata_uri,launch_signature,launch_time,schedule_anchor,cycle_seconds,cutoff_lead_seconds,primary_target_mint,token_program,decimals)
   VALUES($1,$2,'created_pending_activation','third_party',$3,'v3',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(mint) DO NOTHING`,
   [a.mint,c.policy,a.namespace,a.policy_version,addr.intake.toBase58(),a.wallet,a.user_id,a.name,a.symbol,a.image_uri,a.metadata_uri,signature,Number(c.anchor),Number(c.anchor),Number(c.cycleSeconds),Number(c.cutoffLead),a.primary_target_mint,m.owner.toBase58(),m.data[44]]);
  await t.query("UPDATE reward_launch_attempts SET state='created_pending_activation',activation_state='created_pending_activation',updated_at=now() WHERE id=$1",[a.id]);
 });
 await Logs.log(db,{component:'launch',eventType:'token_created',mint:a.mint,message:'Token created on Pump with its REBOUND treasury as creator; rewards are inactive until setup is verified'});
}
async function recordActivation(ports,a,v){
 const {db}=ports;
 await DB.transaction(db,async t=>{
  await t.query("UPDATE reward_coins SET status='active',sharing_config=$2,activation_time=$3,updated_at=now() WHERE mint=$1",[a.mint,v.sharingConfig,v.anchor]);
  await t.query("UPDATE reward_launch_attempts SET state='active',activation_state='active',updated_at=now() WHERE id=$1",[a.id]);
  await t.query(`INSERT INTO reward_public_tokens(mint,namespace,kind,name,symbol,image_uri,creator_wallet,launch_time,reward_status,test) VALUES($1,$2,'third_party',$3,$4,$5,$6,$7,'active',$8)
   ON CONFLICT(mint) DO UPDATE SET reward_status='active'`,[a.mint,a.namespace,a.name,a.symbol,a.image_uri,a.wallet,v.anchor,a.namespace==='mainnet_test']);
 });
 await Logs.log(db,{component:'launch',eventType:'rewards_active',mint:a.mint,message:'Fee routing verified on chain (intake is the sole locked shareholder); rewards active'});
}

/** 5. Remaining activation steps, derived from the chain (resumable). */
async function activationPrepare(ports,{session,attemptId}){
 const {db,connection,program}=ports;const a=await attempt(db,attemptId,session.userId);
 if(!['created_pending_activation','activating'].includes(a.state))fail('LAUNCH_STATE',`Launch is ${a.state}`,409);
 const mint=new PublicKey(a.mint),sc=PV.SDK.feeSharingConfigPda(mint);
 const [scInfo,coinInfo,bcInfo]=await connection.getMultipleAccountsInfo([sc,W3.addresses(program,mint).coin,PV.SDK.bondingCurvePda(mint)],'confirmed');
 const graduated=bcInfo?PV.sdk.decodeBondingCurve(bcInfo).complete:false;
 const r=await PV.routingSteps(program,mint,{payer:a.wallet,setup:scInfo?0n:await PV.setupLamports(connection),graduated});
 const steps=[];if(!scInfo)steps.push({name:'create_fee_sharing',ixs:r.createSteps});
 const locked=scInfo?PV.sdk.decodeSharingConfig(scInfo).adminRevoked:false;if(!locked)steps.push({name:'lock_fee_sharing',ixs:r.lockSteps});
 const active=coinInfo?W3.decode('coin',coinInfo.data).active:false;if(!active&&locked)steps.push({name:'activate',ixs:[r.activate]});
 if(!steps.length)return{attemptId:a.id,steps:[],state:a.state};
 const bh=await connection.getLatestBlockhash('confirmed');
 const body={mint:a.mint,steps:steps.map(s=>({name:s.name,ixs:s.ixs.map(ixJson)})),blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight};
 await db.query("INSERT INTO reward_intents(id,kind,mint,job,namespace,body,body_hash,signer_role,state) VALUES($1,'activation',$2,$3,$4,$5,$6,'creator','awaiting_signature') ON CONFLICT(kind,job) DO UPDATE SET body=EXCLUDED.body,body_hash=EXCLUDED.body_hash,state='awaiting_signature',updated_at=now()",
  [crypto.randomUUID(),a.mint,`activation:${a.id}`,a.namespace,stable(body),P3.canonicalHash(body)]);
 await setAttempt(db,a.id,'activating',{},'activating');
 return{attemptId:a.id,state:'activating',steps:steps.map(s=>({name:s.name,transaction:unsigned(s.ixs,a.wallet,bh)})),
  note:'Each step is a separate wallet signature; you can stop and resume. Rewards start only after all steps are verified on chain.',setupRentLamports:r.setupLamports};
}
/** 6. One signed activation step. */
async function activationSubmit(ports,{session,attemptId,step,signedTransaction}){
 const {db,connection}=ports;const a=await attempt(db,attemptId,session.userId);
 if(a.state!=='activating')fail('LAUNCH_STATE',`Launch is ${a.state}`,409);
 const intent=(await db.query("SELECT * FROM reward_intents WHERE kind='activation' AND job=$1",[`activation:${a.id}`])).rows[0];if(!intent)fail('PLAN_STALE','Prepare the setup first',409);
 const s=intent.body.steps.find(x=>x.name===step);if(!s)fail('PLAN_STALE','This setup step is not pending',409);
 let tx;try{tx=Transaction.from(Buffer.from(signedTransaction,'base64'));}catch{fail('INVALID_TRANSACTION','Unsupported transaction encoding');}
 if(!T.matchesIntent(tx,{instructions:s.ixs.map(ixFrom),signer:a.wallet,blockhash:intent.body.blockhash}))fail('FORBIDDEN','Signed transaction does not match the prepared setup step',403);
 const r=await T.persistAndBroadcast(db,connection,{job:`activation:${a.id}:${step}:${intent.body.blockhash}`,kind:'activation',mint:a.mint,signerRole:'creator',intentId:intent.id,bytes:tx.serialize(),signature:bs58.encode(tx.signature),lastValidBlockHeight:intent.body.lastValidBlockHeight,context:{step}});
 await Logs.log(db,{component:'launch',eventType:'activation_step_submitted',mint:a.mint,message:`Setup step ${step} signed and submitted`,metadata:{signature:r.signature}});
 return{state:r.state,signature:r.signature,step};
}

module.exports={draft,prepare,submit,status,activationPrepare,activationSubmit,launchAllowed,ixJson,ixFrom,simulate};
