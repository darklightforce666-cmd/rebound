'use strict';
// Administrator operations (spec §11). Every mutation is called by the API only after
// (1) a verified Supabase session whose wallet is an unrevoked REBOUND admin and (2) a one-time
// signed consent for the exact payload. On-chain governance actions are returned as exact
// unsigned transactions for the connected admin wallet (the program's upgrade authority) and are
// verified byte-for-byte before broadcast; the server never holds that key.
const crypto=require('node:crypto'),bs58=require('bs58');
const {Transaction,PublicKey}=require('@solana/web3.js');
const DB=require('./db.cjs'),W3=require('./wire-v3.cjs'),P3=require('./policy-v3.cjs'),T=require('./transport-v3.cjs'),Logs=require('./logs.cjs'),FS=require('./funding-store.cjs'),{stable}=require('./policy.cjs');
const {ixJson,ixFrom}=require('./launch-v3.cjs');
const fail=(code,message,status=400)=>{throw Object.assign(Error(message),{code,status});};
const lamports=(v,name)=>{const s=String(v??'');if(!/^\d{1,19}$/.test(s))fail('INVALID_BODY',`Invalid ${name}`);return BigInt(s);};
const address=(v,name)=>{try{return new PublicKey(String(v)).toBase58();}catch{fail('INVALID_BODY',`Invalid ${name} address`);}};
const NS=v=>v==='production'?'production':v==='mainnet_test'?'mainnet_test':fail('INVALID_BODY','Unknown namespace');
const audit=(db,actor,kind,evidence)=>db.query("INSERT INTO reward_audit(kind,actor,evidence) VALUES($1,$2,$3)",[kind,actor,stable(evidence)]);

/** Everything the admin dashboard shows (no secrets: signer rows expose only public fields). */
async function overview(db,{connection=null,program=null}={}){
 const q=(sql,a=[])=>db.query(sql,a).then(r=>r.rows);
 const [platform,coins,wallets,cycles,jobs,receipts,health,admins,signers]=await Promise.all([
  q('SELECT namespace,execution_mode,policy_version,primary_mint,config_version,test_allowlist_mints,test_allowlist_wallets,spend_cap_action_lamports,spend_cap_cycle_lamports,spend_cap_total_lamports,spent_total_lamports,buyback_max_slippage_bps,buyback_max_impact_bps,paused,pause_reason,updated_at FROM reward_platform ORDER BY namespace'),
  q("SELECT mint,kind,namespace,status,blocked_reason,policy_version,name,symbol,intake,creator_wallet,primary_target_mint,launch_time,schedule_anchor FROM reward_coins WHERE program_version='v3' ORDER BY kind,created_at DESC LIMIT 200"),
  q('SELECT id,namespace,mint,address,mode,status,operational_reserve_lamports,opening_balance_lamports,opening_credit_lamports,opening_slot,signer FROM reward_funding_wallets ORDER BY created_at DESC'),
  q('SELECT id,mint,cycle_number,state,cutoff_time,scheduled_end,total_lamports,eligible_count,reason,funding_mode,plan_expires_at FROM reward_cycles ORDER BY created_at DESC LIMIT 60'),
  q('SELECT id,source_mint,source_cycle_id,target_mint,budget_lamports,state,route,spent_lamports,acquired_raw,burned_raw,purchase_signature,burn_signature,reason,updated_at FROM reward_buyback_jobs ORDER BY created_at DESC LIMIT 60'),
  q('SELECT mint,signature,amount_lamports,state,holder_lamports,buyback_lamports,reason,slot FROM reward_intake_receipts ORDER BY created_at DESC LIMIT 60'),
  q('SELECT * FROM reward_health ORDER BY component'),
  q('SELECT wallet,label,added_by,added_at,revoked_at FROM reward_admin_wallets ORDER BY added_at'),
  q('SELECT id,address,role,storage,status,created_at,last_health_at,last_health_ok FROM reward_signers ORDER BY created_at DESC'),
 ]);
 const accounts=await q('SELECT * FROM reward_funding_accounts');
 let chain=null;
 if(connection&&program){try{const a=W3.addresses(program);const info=await connection.getAccountInfo(a.deployment,'confirmed');
  chain={program:new PublicKey(program).toBase58(),deployment:a.deployment.toBase58(),initialized:!!info,state:info?W3.decode('deployment',info.data):null};}catch(e){chain={error:e.message};}}
 return{platform,coins,fundingWallets:wallets,fundingAccounts:accounts,cycles,buybackJobs:jobs,receipts,health,admins,signers,chain,
  hostCeiling:require('./execution.cjs').ceiling(),productionAllowed:process.env.REWARDS_ALLOW_PRODUCTION==='true',now:new Date().toISOString()};
}

/** Execution mode. Production is refused unless the host explicitly allows it (never for a private test). */
async function setMode(db,actor,{namespace,mode,reason}){
 namespace=NS(namespace);if(!['dry_run','mainnet_test','production'].includes(mode))fail('INVALID_BODY','Unknown mode');
 if(mode==='production'&&process.env.REWARDS_ALLOW_PRODUCTION!=='true')fail('PRODUCTION_LOCKED','Production is locked on this host (REWARDS_ALLOW_PRODUCTION). It is never enabled as part of a private test.',409);
 if((namespace==='production'&&mode==='mainnet_test')||(namespace==='mainnet_test'&&mode==='production'))fail('NAMESPACE','That mode does not apply to this namespace',409);
 await db.query('UPDATE reward_platform SET execution_mode=$2,config_version=config_version+1,updated_at=now() WHERE namespace=$1',[namespace,mode]);
 await audit(db,actor,'admin_set_mode',{namespace,mode,reason:String(reason||'').slice(0,200)});
 await Logs.log(db,{severity:'warn',component:'admin',eventType:'execution_mode_changed',namespace,message:`Execution mode for ${namespace} set to ${mode} by ${actor}`});
 return{namespace,mode,ceiling:require('./execution.cjs').ceiling()};
}

/** Private-test allowlists, spend caps and buyback limits. */
async function testConfig(db,actor,{namespace='mainnet_test',mints=[],wallets=[],capAction,capCycle,capTotal,slippageBps,impactBps}){
 namespace=NS(namespace);if(!Array.isArray(mints)||!Array.isArray(wallets)||mints.length>50||wallets.length>200)fail('INVALID_BODY','Invalid allowlists');
 const m=[...new Set(mints.map(x=>address(x,'mint')))],w=[...new Set(wallets.map(x=>address(x,'wallet')))];
 const s=Number(slippageBps),i=Number(impactBps);if(!(s>=1&&s<=300)||!(i>=1&&i<=1000))fail('INVALID_BODY','Slippage 1–300 bps, impact 1–1000 bps');
 const a=lamports(capAction,'per-action cap'),c=lamports(capCycle,'per-cycle cap'),t=lamports(capTotal,'total cap');
 if(a>c||c>t)fail('INVALID_BODY','Caps must satisfy action ≤ cycle ≤ total');
 await db.query('UPDATE reward_platform SET test_allowlist_mints=$2,test_allowlist_wallets=$3,spend_cap_action_lamports=$4,spend_cap_cycle_lamports=$5,spend_cap_total_lamports=$6,buyback_max_slippage_bps=$7,buyback_max_impact_bps=$8,config_version=config_version+1,updated_at=now() WHERE namespace=$1',
  [namespace,m,w,String(a),String(c),String(t),s,i]);
 await audit(db,actor,'admin_test_config',{namespace,mints:m,wallets:w,caps:[String(a),String(c),String(t)],slippageBps:s,impactBps:i});
 await Logs.log(db,{component:'admin',eventType:'test_config_changed',namespace,message:`Test allowlists/caps updated by ${actor}`});
 return{namespace,mints:m,wallets:w};
}

async function pause(db,actor,{namespace,paused,reason}){
 namespace=NS(namespace);await db.query('UPDATE reward_platform SET paused=$2,pause_reason=$3,updated_at=now() WHERE namespace=$1',[namespace,!!paused,paused?String(reason||'paused by admin').slice(0,200):null]);
 await audit(db,actor,paused?'admin_pause':'admin_resume',{namespace,reason});
 await Logs.log(db,{severity:'warn',component:'admin',eventType:paused?'platform_paused':'platform_resumed',namespace,message:`${namespace} ${paused?'paused':'resumed'} by ${actor}`});return{namespace,paused:!!paused};
}

/**
 * Register the PRIMARY coin and its dedicated dev funding wallet (manual mode by default).
 * The funding wallet must be one of the caller's verified REBOUND wallets (ownership proven by sign-in).
 */
const OPEN_CYCLE="state NOT IN ('complete','skipped_no_funds','skipped_no_eligible_holders','missed','expired','failed_action_required')";
/**
 * Register (or switch) the namespace's primary REBOUND token and its dev fee wallet. Not one-off:
 * the admin may point the site at another mint or wallet later. A switch retires the previous
 * primary / wallet only when it has no round in progress, so funded awards are never orphaned.
 * Registering spends nothing: every deposit still needs the dev wallet's own signature (manual) or
 * its imported key on the scheduler host (automatic), and execution stays under the mode gates.
 */
async function registerPrimary(db,actor,session,{namespace,mint,fundingWallet}){
 namespace=NS(namespace);mint=address(mint,'mint');fundingWallet=address(fundingWallet,'funding wallet');
 const plat=(await db.query('SELECT * FROM reward_platform WHERE namespace=$1',[namespace])).rows[0];
 const policyHash=P3.hashOf(P3.policy(plat.policy_version));
 const proven=(session?.reboundWallets||[]).includes(fundingWallet);
 const busy=async(t,m)=>(await t.query(`SELECT 1 FROM reward_cycles WHERE mint=$1 AND ${OPEN_CYCLE} LIMIT 1`,[m])).rows.length>0;
 let replaced=null;
 await DB.transaction(db,async t=>{
  const existing=(await t.query("SELECT kind,namespace,status FROM reward_coins WHERE mint=$1",[mint])).rows[0];
  if(existing&&existing.kind!=='primary')fail('MINT_EXISTS','This mint is registered as a third-party coin',409);
  if(existing&&existing.namespace!==namespace)fail('NAMESPACE','This mint is already the primary of the '+existing.namespace+' namespace',409);
  if(plat.primary_mint&&plat.primary_mint!==mint){
   if(await busy(t,plat.primary_mint))fail('PRIMARY_BUSY','The current token still has a round in progress; wait until it completes (or expires), then switch.',409);
   await t.query("UPDATE reward_coins SET status='retired',updated_at=now() WHERE mint=$1 AND kind='primary' AND status<>'retired'",[plat.primary_mint]);
   await t.query("UPDATE reward_funding_wallets SET status='retired',retired_at=now() WHERE mint=$1 AND status<>'retired'",[plat.primary_mint]);
   replaced=plat.primary_mint;
  }
  await t.query(`INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES($1,$2,'registered','primary',$3,'v3',$4)
   ON CONFLICT(mint) DO UPDATE SET status=CASE WHEN reward_coins.status='retired' THEN 'registered' ELSE reward_coins.status END,updated_at=now()`,[mint,policyHash,namespace,plat.policy_version]);
  const live=(await t.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[mint])).rows[0];
  if(live&&live.address!==fundingWallet){
   if(await busy(t,mint))fail('PRIMARY_BUSY','A round is in progress for this token; change the fee wallet after it completes.',409);
   await t.query("UPDATE reward_funding_wallets SET status='retired',retired_at=now() WHERE id=$1",[live.id]);
  }
  const other=(await t.query("SELECT mint FROM reward_funding_wallets WHERE address=$1 AND status<>'retired' AND mint<>$2",[fundingWallet,mint])).rows[0];
  if(other)fail('FUNDING_WALLET_EXISTS','This wallet already funds another token ('+other.mint+')',409);
  if(!live||live.address!==fundingWallet)await t.query("INSERT INTO reward_funding_wallets(id,namespace,mint,address,mode,ownership_proof) VALUES($1,$2,$3,$4,'manual',$5)",
   [crypto.randomUUID(),namespace,mint,fundingWallet,stable(proven?{method:'supabase_siws_session',userId:session.userId,wallet:fundingWallet,at:new Date().toISOString()}:{method:'admin_declared',by:actor,at:new Date().toISOString()})]);
  await t.query('UPDATE reward_platform SET primary_mint=$2,config_version=config_version+1,updated_at=now() WHERE namespace=$1',[namespace,mint]);
 });
 await audit(db,actor,'admin_register_primary',{namespace,mint,fundingWallet,proven,replaced});
 await Logs.log(db,{severity:'warn',component:'admin',eventType:'primary_registered',namespace,mint,message:`Primary ${mint} with dev wallet ${fundingWallet} (${proven?'proven':'declared'}, manual funding) set by ${actor}`+(replaced?`; replaced ${replaced}`:'')});
 return{mint,fundingWallet,policy:plat.policy_version,policyHash,proven,replaced};
}

// ---------------- site settings (public; admin + consent) ----------------
async function site(db){return(await db.query('SELECT site_open,primary_mint,primary_name,primary_symbol,fee_wallet,namespace,privy_app_id,updated_at FROM reward_site WHERE id=1')).rows[0]||null;}
async function setSite(db,actor,{open,privyAppId}){
 const sets=[],args=[];
 if(open!==undefined){if(typeof open!=='boolean')fail('INVALID_BODY','open must be true or false');args.push(open);sets.push('site_open=$'+args.length);}
 if(privyAppId!==undefined){const v=privyAppId===null||privyAppId===''?null:String(privyAppId).trim();if(v!==null&&!/^[A-Za-z0-9_-]{8,64}$/.test(v))fail('INVALID_BODY','That does not look like a Privy App ID');args.push(v);sets.push('privy_app_id=$'+args.length);}
 if(!sets.length)fail('INVALID_BODY','Nothing to change');
 args.push(actor);await db.query(`UPDATE reward_site SET ${sets.join(',')},updated_by=$${args.length},updated_at=now() WHERE id=1`,args);
 await audit(db,actor,'admin_site',{open,privyAppId});
 await Logs.log(db,{severity:'warn',component:'admin',eventType:'site_settings_changed',message:`Site settings changed by ${actor}`+(open!==undefined?` · site ${open?'open to everyone':'password-protected'}`:'')+(privyAppId!==undefined?' · Privy App ID '+(privyAppId?'set':'cleared'):'')});
 return site(db);
}
// Token name/symbol from the mint's Token-2022 metadata extension (Pump create_v2); best effort.
async function tokenMeta(connection,mint){
 try{const info=await connection.getParsedAccountInfo(new PublicKey(mint),'confirmed');const p=info.value?.data?.parsed;if(!p||p.type!=='mint')return{exists:false};
  const md=(p.info.extensions||[]).find(e=>e.extension==='tokenMetadata')?.state;return{exists:true,name:md?.name?String(md.name).slice(0,64):null,symbol:md?.symbol?String(md.symbol).slice(0,16):null};}
 catch{return{exists:null};}
}
/** "Launch" from the dashboard: set the site's REBOUND token + dev fee wallet and register it as the primary. */
async function launch(db,actor,session,{mint,feeWallet,namespace='production'},{connection=null}={}){
 mint=address(mint,'token contract');feeWallet=address(feeWallet,'fee wallet');namespace=NS(namespace);
 const r=await registerPrimary(db,actor,session,{namespace,mint,fundingWallet:feeWallet});
 const meta=connection?await tokenMeta(connection,mint):{exists:null};
 await db.query('UPDATE reward_site SET primary_mint=$1,primary_name=$2,primary_symbol=$3,fee_wallet=$4,namespace=$5,updated_by=$6,updated_at=now() WHERE id=1',[mint,meta.name||null,meta.symbol||null,feeWallet,namespace,actor]);
 await db.query('UPDATE reward_coins SET name=COALESCE($2,name),symbol=COALESCE($3,symbol),updated_at=now() WHERE mint=$1',[mint,meta.name||null,meta.symbol||null]).catch(()=>{});
 await Logs.log(db,{severity:'warn',component:'admin',eventType:'site_token_changed',namespace,mint,message:`Site token set to ${meta.name||mint} (${mint}); fee wallet ${feeWallet}`+(meta.exists===false?' — no mint exists at this address yet':'')});
 return{...r,exists:meta.exists,name:meta.name||null,symbol:meta.symbol||null,site:await site(db)};
}

/**
 * Opening credit request: the part of the dev wallet's balance that counts as funding (split once).
 * The API only records the admin's request; the scheduler (which alone writes funding ledgers)
 * reads the finalized balance and applies it exactly once (worker-v3 applyOpeningRequests).
 */
async function openingCredit(db,actor,{mint,requestedCreditLamports,operationalReserveLamports}){
 mint=address(mint,'mint');const fw=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[mint])).rows[0];if(!fw)fail('NOT_FOUND','Register the primary and its dev wallet first',404);
 if(fw.opening_slot!=null)fail('ALREADY_RECORDED','The opening credit was already recorded for this wallet',409);
 const credit=lamports(requestedCreditLamports,'opening credit'),reserve=lamports(operationalReserveLamports,'operational reserve');
 const body={mint,wallet:fw.address,credit:String(credit),reserve:String(reserve),requestedBy:actor};
 await db.query("INSERT INTO reward_intents(id,kind,mint,job,namespace,body,body_hash,amount_lamports,signer_role,state) VALUES($1,'setup',$2,$3,$4,$5,$6,$7,'admin','prepared') ON CONFLICT(kind,job) DO UPDATE SET body=EXCLUDED.body,body_hash=EXCLUDED.body_hash,state='prepared',updated_at=now()",
  [crypto.randomUUID(),mint,`opening:${mint}`,fw.namespace,stable(body),P3.canonicalHash(body),String(credit)]);
 await audit(db,actor,'admin_opening_credit_requested',body);
 return{...body,state:'requested'};
}
/** Scheduler side: apply pending opening-credit requests against the finalized dev-wallet balance. */
async function applyOpeningRequests(db,connection){
 const rows=(await db.query("SELECT * FROM reward_intents WHERE kind='setup' AND job LIKE 'opening:%' AND state='prepared'")).rows;const out=[];
 for(const r of rows){const b=r.body;
  try{const bal=await connection.getBalanceAndContext(new PublicKey(b.wallet),'finalized');const time=await connection.getBlockTime(bal.context.slot);
   if(BigInt(b.credit)+BigInt(b.reserve)>BigInt(bal.value))throw Object.assign(Error(`The dev wallet holds ${bal.value} lamports`),{code:'INSUFFICIENT_BALANCE'});
   await FS.recordOpening(db,{mint:b.mint,wallet:b.wallet,balance:BigInt(bal.value),requestedCredit:BigInt(b.credit),operationalReserve:BigInt(b.reserve),slot:bal.context.slot,time});
   await db.query("UPDATE reward_intents SET state='finalized',updated_at=now() WHERE id=$1",[r.id]);
   await Logs.log(db,{component:'scheduler',eventType:'opening_credit_recorded',mint:b.mint,message:`Opening credit ${b.credit} lamports (reserve ${b.reserve}) recorded at finalized slot ${bal.context.slot}; split once`});out.push({mint:b.mint,state:'recorded'});}
  catch(e){await db.query("UPDATE reward_intents SET state='failed',updated_at=now() WHERE id=$1",[r.id]);await Logs.log(db,{severity:'warn',component:'scheduler',eventType:'opening_credit_refused',mint:b.mint,message:e.message,errorCode:e.code||'OPENING_REFUSED'});out.push({mint:b.mint,state:'failed',reason:e.message});}
 }
 return out;
}

/**
 * Scheduler side: a registered primary becomes `active` in the database only after the chain says so
 * (StartPrimary finalized) AND the on-chain coin agrees with the database on kind, policy hash and
 * dev funding wallet. The schedule itself is always read from the chain, never copied.
 */
async function syncPrimary(db,{connection,program}){
 const rows=(await db.query("SELECT c.*,p.hash AS policy_hash_db FROM reward_coins c JOIN reward_policies p ON p.version=c.policy_version WHERE c.kind='primary' AND c.program_version='v3' AND c.status IN ('registered','indexing','ready')")).rows;const out=[];
 for(const c of rows){
  const info=await connection.getAccountInfo(W3.addresses(program,new PublicKey(c.mint)).coin,'finalized');const on=info&&info.owner.equals(program)?W3.decode('coin',info.data):null;
  if(!on||!on.active){out.push({mint:c.mint,state:'waiting_for_start'});continue;}
  const fw=(await db.query("SELECT address FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[c.mint])).rows[0];
  const reason=on.kind!=='primary'?'on-chain coin is not a primary':on.policy!==c.policy_hash_db?'on-chain policy differs from the database policy':!fw||on.fundingWallet!==fw.address?'on-chain dev funding wallet differs from the registered one':null;
  if(reason){if(c.blocked_reason!==reason){await db.query('UPDATE reward_coins SET blocked_reason=$2,updated_at=now() WHERE mint=$1',[c.mint,reason]);
    await Logs.log(db,{severity:'critical',component:'scheduler',eventType:'primary_mismatch',mint:c.mint,message:'Primary not activated: '+reason,errorCode:'PRIMARY_MISMATCH'});}
   out.push({mint:c.mint,state:'blocked',reason});continue;}
  await db.query("UPDATE reward_coins SET status='active',blocked_reason=NULL,updated_at=now() WHERE mint=$1",[c.mint]);
  await Logs.log(db,{severity:'warn',component:'scheduler',eventType:'primary_active',mint:c.mint,message:`Primary active on chain (anchor ${on.anchor}, ${on.cycleSeconds}s cycles); scheduling enabled`});
  out.push({mint:c.mint,state:'active'});
 }
 return out;
}

// ---------------- on-chain governance (admin wallet signs) ----------------
const CHAIN_ACTIONS=new Set(['initialize','setBuybackTarget','registerPrimary','startPrimary','setFundingWallet','pause','requestResume','resume']);
function chainInstruction(program,admin,action,p){
 switch(action){
  case'initialize':{const pol=p.testMode?P3.hashOf(P3.TEST_POLICY):P3.POLICY_HASH;
   return W3.I.initialize(program,{admin,publisher:address(p.publisher,'publisher'),verifier:address(p.verifier,'verifier'),guardian:address(p.guardian,'guardian'),policy:pol,testMode:!!p.testMode});}
  case'setBuybackTarget':return W3.I.setBuybackTarget(program,{admin,targetMint:address(p.targetMint,'target mint')});
  case'registerPrimary':return W3.I.registerPrimary(program,{admin,mint:address(p.mint,'mint'),fundingWallet:address(p.fundingWallet,'funding wallet')});
  case'startPrimary':return W3.I.startPrimary(program,{admin,mint:address(p.mint,'mint')});
  case'setFundingWallet':return W3.I.setFundingWallet(program,{admin,mint:address(p.mint,'mint'),fundingWallet:address(p.fundingWallet,'funding wallet')});
  case'pause':return W3.I.pause(program,{authority:admin});
  case'requestResume':return W3.I.requestResume(program,{admin});
  case'resume':return W3.I.resume(program,{admin});
 }
}
async function chainPrepare(db,{connection,program},{admin,action,params={}}){
 if(!program)fail('SETUP_REQUIRED','REWARDS_PROGRAM_ID is not configured',503);if(!CHAIN_ACTIONS.has(action))fail('INVALID_BODY','Unknown program action');
 admin=address(admin,'admin');const ix=chainInstruction(program,admin,action,params);
 const {VersionedTransaction,TransactionMessage}=require('@solana/web3.js');
 const sim=await connection.simulateTransaction(new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(admin),recentBlockhash:PublicKey.default.toBase58(),instructions:[ix]}).compileToLegacyMessage()),{sigVerify:false,replaceRecentBlockhash:true});
 if(sim.value.err)fail('SIMULATION_FAILED',`The program would reject ${action}: ${W3.errorName(sim.value.err)||JSON.stringify(sim.value.err).slice(0,120)}`,422);
 const bh=await connection.getLatestBlockhash('confirmed');
 const body={action,params,admin,ix:ixJson(ix),blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight};
 const id=crypto.randomUUID();
 await db.query("INSERT INTO reward_intents(id,kind,job,namespace,body,body_hash,signer_role,state) VALUES($1,'setup',$2,'production',$3,$4,'admin','awaiting_signature')",[id,`governance:${id}`,stable(body),P3.canonicalHash(body)]);
 const tx=new Transaction({feePayer:new PublicKey(admin),blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ix);
 return{intentId:id,action,transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')};
}
async function chainSubmit(db,{connection},adminWallets,{intentId,signedTransaction}){
 const intent=(await db.query("SELECT * FROM reward_intents WHERE id=$1 AND kind='setup' AND state='awaiting_signature'",[intentId])).rows[0];if(!intent)fail('PLAN_STALE','This program action is no longer awaiting a signature',409);
 const actor=intent.body.admin;if(!(Array.isArray(adminWallets)?adminWallets:[adminWallets]).includes(actor))fail('FORBIDDEN','This action was prepared for another administrator wallet',403);
 let tx;try{tx=Transaction.from(Buffer.from(signedTransaction,'base64'));}catch{fail('INVALID_TRANSACTION','Unsupported transaction encoding');}
 if(!T.matchesIntent(tx,{instructions:[ixFrom(intent.body.ix)],signer:intent.body.admin,blockhash:intent.body.blockhash}))fail('FORBIDDEN','Signed transaction does not match the prepared program action',403);
 const r=await T.persistAndBroadcast(db,connection,{job:intent.job,kind:'setup',mint:intent.body.params?.mint||null,signerRole:'admin',intentId,bytes:tx.serialize(),signature:bs58.encode(tx.signature),lastValidBlockHeight:intent.body.lastValidBlockHeight,context:{action:intent.body.action}});
 await db.query("UPDATE reward_intents SET state='submitted',updated_at=now() WHERE id=$1",[intentId]);
 await audit(db,actor,'admin_program_action',{action:intent.body.action,params:intent.body.params,signature:r.signature});
 await Logs.log(db,{severity:'warn',component:'admin',eventType:'program_action_submitted',message:`Program action ${intent.body.action} signed by ${intent.body.admin} and submitted`,metadata:{signature:r.signature}});
 return{state:r.state,signature:r.signature};
}

async function addAdmin(db,actor,{wallet,label}){wallet=address(wallet,'wallet');await db.query('INSERT INTO reward_admin_wallets(wallet,label,added_by) VALUES($1,$2,$3) ON CONFLICT(wallet) DO UPDATE SET revoked_at=NULL,revoked_by=NULL',[wallet,String(label||'admin').slice(0,60),actor]);await audit(db,actor,'admin_add',{wallet});return{wallet};}
async function revokeAdmin(db,actor,{wallet}){wallet=address(wallet,'wallet');if(wallet===actor)fail('FORBIDDEN','You cannot revoke your own admin wallet',409);
 const left=(await db.query('SELECT count(*)::int n FROM reward_admin_wallets WHERE revoked_at IS NULL AND wallet<>$1',[wallet])).rows[0].n;if(!left)fail('FORBIDDEN','At least one admin must remain',409);
 await db.query('UPDATE reward_admin_wallets SET revoked_at=now(),revoked_by=$2 WHERE wallet=$1',[wallet,actor]);await audit(db,actor,'admin_revoke',{wallet});return{wallet,revoked:true};}

module.exports={overview,setMode,testConfig,pause,registerPrimary,site,setSite,launch,tokenMeta,openingCredit,applyOpeningRequests,syncPrimary,chainPrepare,chainSubmit,addAdmin,revokeAdmin,CHAIN_ACTIONS};
