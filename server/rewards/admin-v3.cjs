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
  q('SELECT namespace,execution_mode,settlement,policy_version,primary_mint,config_version,test_allowlist_mints,test_allowlist_wallets,test_any_recipient,spend_cap_action_lamports,spend_cap_cycle_lamports,spend_cap_total_lamports,spent_total_lamports,buyback_max_slippage_bps,buyback_max_impact_bps,paused,pause_reason,updated_at FROM reward_platform ORDER BY namespace'),
  q("SELECT mint,kind,namespace,status,blocked_reason,policy_version,name,symbol,intake,creator_wallet,primary_target_mint,launch_time,schedule_anchor FROM reward_coins WHERE program_version='v3' AND status<>'retired' ORDER BY kind,created_at DESC LIMIT 200"),
  q('SELECT id,namespace,mint,address,mode,status,funding_model,budget_bps,budget_requested_at,budget_balance_lamports,budget_lamports,budget_start_deposits,budget_set_at,operational_reserve_lamports,opening_balance_lamports,opening_credit_lamports,opening_slot,signer FROM reward_funding_wallets WHERE status<>\'retired\' ORDER BY created_at DESC'),
  q('SELECT id,mint,cycle_number,state,cutoff_time,scheduled_end,holder_reserve_lamports,total_lamports,total_loss_usd,eligible_count,reason,funding_mode,plan_expires_at FROM reward_cycles c WHERE NOT (c.state=\'scheduled\' AND EXISTS (SELECT 1 FROM reward_coins k WHERE k.mint=c.mint AND k.status=\'retired\')) ORDER BY created_at DESC LIMIT 60'),
  q('SELECT id,source_mint,source_cycle_id,target_mint,budget_lamports,state,route,spent_lamports,acquired_raw,burned_raw,purchase_signature,burn_signature,reason,updated_at FROM reward_buyback_jobs ORDER BY created_at DESC LIMIT 60'),
  q('SELECT mint,signature,amount_lamports,state,holder_lamports,buyback_lamports,reason,slot FROM reward_intake_receipts ORDER BY created_at DESC LIMIT 60'),
  q('SELECT * FROM reward_health ORDER BY component'),
  q('SELECT wallet,label,added_by,added_at,revoked_at FROM reward_admin_wallets ORDER BY added_at'),
  q('SELECT id,address,role,storage,status,created_at,last_health_at,last_health_ok FROM reward_signers ORDER BY created_at DESC'),
 ]);
 const accounts=await q("SELECT a.* FROM reward_funding_accounts a JOIN reward_coins k USING(mint) WHERE k.status<>'retired'");
 const workerKey=(await q('SELECT inbox_public_key,worker,updated_at FROM reward_worker_keys WHERE id=1'))[0]||null;
 const keyInbox=await q('SELECT id,funding_wallet,address,state,reason,created_at,processed_at FROM reward_key_inbox ORDER BY created_at DESC LIMIT 10');
 let chain=null;
 if(connection&&program){try{const a=W3.addresses(program);const info=await connection.getAccountInfo(a.deployment,'confirmed');
  chain={program:new PublicKey(program).toBase58(),deployment:a.deployment.toBase58(),initialized:!!info,state:info?W3.decode('deployment',info.data):null};}catch(e){chain={error:e.message};}}
 return{platform,coins,fundingWallets:wallets,fundingAccounts:accounts,workerKey,keyInbox,cycles,buybackJobs:jobs,receipts,health,admins,signers,chain,
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
async function testConfig(db,actor,{namespace='mainnet_test',mints=[],wallets=[],capAction,capCycle,capTotal,slippageBps,impactBps,anyRecipient}){
 namespace=NS(namespace);if(!Array.isArray(mints)||!Array.isArray(wallets)||mints.length>50||wallets.length>200)fail('INVALID_BODY','Invalid allowlists');
 const m=[...new Set(mints.map(x=>address(x,'mint')))],w=[...new Set(wallets.map(x=>address(x,'wallet')))];
 const s=Number(slippageBps),i=Number(impactBps);if(!(s>=1&&s<=300)||!(i>=1&&i<=1000))fail('INVALID_BODY','Slippage 1–300 bps, impact 1–1000 bps');
 const a=lamports(capAction,'per-action cap'),c=lamports(capCycle,'per-cycle cap'),t=lamports(capTotal,'total cap');
 if(a>c||c>t)fail('INVALID_BODY','Caps must satisfy action ≤ cycle ≤ total');
 await db.query('UPDATE reward_platform SET test_allowlist_mints=$2,test_allowlist_wallets=$3,spend_cap_action_lamports=$4,spend_cap_cycle_lamports=$5,spend_cap_total_lamports=$6,buyback_max_slippage_bps=$7,buyback_max_impact_bps=$8,config_version=config_version+1,updated_at=now() WHERE namespace=$1',
  [namespace,m,w,String(a),String(c),String(t),s,i]);
 if(anyRecipient!==undefined)await db.query('UPDATE reward_platform SET test_any_recipient=$2 WHERE namespace=$1',[namespace,!!anyRecipient]);
 await audit(db,actor,'admin_test_config',{namespace,mints:m,wallets:w,caps:[String(a),String(c),String(t)],slippageBps:s,impactBps:i,anyRecipient});
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
// A round blocks a token/wallet switch only while it holds money: reserved awards not yet paid, or a
// deposit in flight. Rounds that only scheduled or computed something (or ran dry) never block.
const OPEN_CYCLE="state IN ('awaiting_funding_signature','funding_pending','funded','paying','partially_paid','retrying')";
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
/**
 * "Launch" from the dashboard: set the site's REBOUND token + dev fee wallet, register it as the
 * primary and choose how holders are funded from that wallet:
 *   balance_budget — budgetPercent of the wallet's CURRENT balance (measured by the scheduler,
 *                    finalized) is the total holders may receive; each round takes only what is left.
 *   income         — 85 % of every new SOL that arrives in the wallet after launch.
 * In the private-test namespace the token is added to the mint allowlist, every eligible holder may
 * be paid (test_any_recipient) and the spend caps are set from the budget; startTest also switches
 * the namespace to mainnet_test execution (never production).
 */
const FEE_MARGIN=10_000_000n,CYCLE_FEE_MARGIN=50_000_000n,TOTAL_FEE_MARGIN=250_000_000n,INCOME_RESERVE=10_000_000n;
function budgetBps(pct){const n=Number(pct);if(!Number.isFinite(n)||n<=0||n>100)fail('INVALID_BODY','Budget must be between 0.01 and 100 percent');const bps=Math.round(n*100);if(bps<1)fail('INVALID_BODY','Budget must be at least 0.01 percent');return bps;}
async function launch(db,actor,session,{mint,feeWallet,namespace='production',fundingModel='balance_budget',budgetPercent=50,startTest=false,newBudget=false,goLive=false},{connection=null,program=null}={}){
 mint=address(mint,'token contract');feeWallet=address(feeWallet,'fee wallet');namespace=NS(namespace);
 // Production go-live (owner decision 2026-09-28): the dashboard's one launch switches the production namespace
 // to real payouts. Only the vault model, only with the host's production lock open, only for a real mint.
 if(goLive){
  if(namespace!=='production')fail('INVALID_BODY','Go-live applies to the production namespace only');
  if(fundingModel!=='income')fail('INVALID_BODY','Production uses the vault funding model (85 % / 20 % per round / 15 % kept)');
  if(process.env.REWARDS_ALLOW_PRODUCTION!=='true'||require('./execution.cjs').ceiling()!=='production')fail('PRODUCTION_LOCKED','Production is locked on this site host: set REWARDS_ALLOW_PRODUCTION=true and REWARDS_MAX_EXECUTION_MODE=production in the Netlify environment, redeploy, then launch again. Nothing was changed.',409);
  if(connection){const m=await tokenMeta(connection,mint);if(m.exists!==true)fail('TOKEN_NOT_FOUND','No token mint exists at this address on Solana mainnet. Nothing was changed.',409);}
 }
 if(!['balance_budget','income'].includes(fundingModel))fail('INVALID_BODY','Unknown funding model');
 const bps=fundingModel==='balance_budget'?budgetBps(budgetPercent):null;
 const admins=(await db.query('SELECT wallet FROM reward_admin_wallets WHERE revoked_at IS NULL')).rows.map(r=>r.wallet);
 if(admins.includes(feeWallet))fail('INVALID_BODY','The fee wallet must be a different wallet from the administrator wallet',409);
 // Only pump.fun tokens can be measured: purchases are read from the bonding curve or the canonical
 // PumpSwap pool. A token that trades elsewhere would never show a purchase, so nobody could be paid.
 if(connection){const meta0=await tokenMeta(connection,mint);
  if(meta0.exists===true&&await pumpMarket(connection,mint)===null)fail('UNSUPPORTED_TOKEN','This is not a pump.fun token (no pump.fun bonding curve or PumpSwap pool). REBOUND can only measure purchases made on pump.fun markets.',409);}
 const r=await registerPrimary(db,actor,session,{namespace,mint,fundingWallet:feeWallet});
 const fw=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[mint])).rows[0];
 // A key already imported on the worker for this wallet keeps deposits automatic after a token switch.
 if(fw.mode==='manual'){const sg=(await db.query("SELECT id FROM reward_signers WHERE role='primary_dev' AND address=$1 AND status='ready' ORDER BY created_at DESC LIMIT 1",[feeWallet])).rows[0];
  if(sg){await db.query("UPDATE reward_funding_wallets SET mode='automatic',signer=$2 WHERE id=$1",[fw.id,sg.id]);fw.mode='automatic';}}
 // The budget is a cumulative commitment of this fee wallet: saving again keeps it (and what was already
 // paid). The percentage can be lowered at any time; a NEW budget from the current balance is measured
 // only on the first budget launch or when the admin explicitly asks for one (audited).
 let budgetAction=null;
 if(fundingModel==='balance_budget'){
  const measured=fw.funding_model==='balance_budget'&&fw.budget_requested_at;
  if(!measured||newBudget){await db.query("UPDATE reward_funding_wallets SET funding_model='balance_budget',budget_bps=$2,budget_requested_at=now() WHERE id=$1",[fw.id,bps]);budgetAction='new';}
  else if(bps!==fw.budget_bps){if(bps>fw.budget_bps)fail('BUDGET_RAISE','Raising the percentage needs a new budget: tick “Fix a new budget from the current balance”.',409);
   await db.query('UPDATE reward_funding_wallets SET budget_bps=$2 WHERE id=$1',[fw.id,bps]);budgetAction='lowered';}
  else budgetAction='kept';
 }else{
  if(fw.funding_model==='balance_budget'||fw.budget_requested_at)fail('MODEL_SWITCH','This fee wallet was used with a budget. To fund holders from 85 % of new fees, launch with a different fee wallet.',409);
  // Owner decision (2026-09-28): the wallet's balance at launch counts as funding too — split 85/15 once like
  // every later fee — so holders are paid from the first round. Only a 0.01 SOL fee reserve is kept out.
  if(fw.opening_slot==null)await openingCredit(db,actor,{mint,requestedCreditLamports:'all',operationalReserveLamports:String(INCOME_RESERVE)});
 }
 let balance=null;if(connection)try{balance=BigInt(await connection.getBalance(new PublicKey(feeWallet),'confirmed'));}catch{}
 const estimate=budgetAction==='new'&&balance!=null?balance*BigInt(bps)/10000n:null;   // caps move only with a new budget
 let test=null;
 if(namespace==='mainnet_test'){
  const p=(await db.query('SELECT * FROM reward_platform WHERE namespace=$1',[namespace])).rows[0];
  const mints=[...new Set([...(p.test_allowlist_mints||[]),mint])];
  const sets=['test_allowlist_mints=$2','test_any_recipient=true'],args=[namespace,mints];
  if(estimate!=null){const a=estimate*11n/10n+FEE_MARGIN,c=a+CYCLE_FEE_MARGIN,t=BigInt(p.spent_total_lamports)+estimate*11n/10n+TOTAL_FEE_MARGIN;
   args.push(String(a),String(c),String(t));sets.push(`spend_cap_action_lamports=$${args.length-2}`,`spend_cap_cycle_lamports=$${args.length-1}`,`spend_cap_total_lamports=$${args.length}`);test={capAction:String(a),capCycle:String(c),capTotal:String(t)};}
  if(startTest&&p.execution_mode==='dry_run')sets.push("execution_mode='mainnet_test'");
  await db.query(`UPDATE reward_platform SET ${sets.join(',')},config_version=config_version+1,updated_at=now() WHERE namespace=$1`,args);
  test={...test,mints,anyRecipient:true,mode:startTest&&p.execution_mode==='dry_run'?'mainnet_test':p.execution_mode};
 }
 // Direct settlement (no program): the token starts its rounds right away; the schedule anchor is kept
 // across relaunches so round numbers never repeat.
 const settlement=(await db.query('SELECT settlement FROM reward_platform WHERE namespace=$1',[namespace])).rows[0]?.settlement||'direct';
 if(settlement==='direct'){const pol=P3.policy((await db.query('SELECT policy_version FROM reward_coins WHERE mint=$1',[mint])).rows[0].policy_version);
  await db.query("UPDATE reward_coins SET status='active',blocked_reason=NULL,schedule_anchor=COALESCE(schedule_anchor,extract(epoch from now())::bigint),cycle_seconds=$2,cutoff_lead_seconds=$3,updated_at=now() WHERE mint=$1",[mint,pol.cycleSeconds,pol.cutoffLeadSeconds]);}
 const meta=connection?await tokenMeta(connection,mint):{exists:null};
 await db.query('UPDATE reward_site SET primary_mint=$1,primary_name=$2,primary_symbol=$3,fee_wallet=$4,namespace=$5,updated_by=$6,updated_at=now() WHERE id=1',[mint,meta.name||null,meta.symbol||null,feeWallet,namespace,actor]);
 await db.query('UPDATE reward_coins SET name=COALESCE($2,name),symbol=COALESCE($3,symbol),updated_at=now() WHERE mint=$1',[mint,meta.name||null,meta.symbol||null]).catch(()=>{});
 if(goLive){await db.query("UPDATE reward_platform SET execution_mode='production',paused=false,pause_reason=NULL,config_version=config_version+1,updated_at=now() WHERE namespace='production'");
  await Logs.log(db,{severity:'warn',component:'admin',eventType:'execution_mode_changed',namespace,mint,message:`Production is live: real payouts from ${feeWallet} (vault model), started by ${actor}`});}
 const how=fundingModel==='balance_budget'?(budgetAction==='new'?`NEW budget ${bps/100}% of the current fee-wallet balance`+(estimate!=null?` (≈${estimate} lamports)`:''):budgetAction==='lowered'?`budget lowered to ${bps/100}%`:`budget kept (${bps/100}%)`):'vault: 85% of the current balance and of every new fee, at most 20% of the vault per round';
 await audit(db,actor,'admin_launch',{namespace,mint,feeWallet,fundingModel,budgetBps:bps,budgetAction,test,goLive:!!goLive});
 await Logs.log(db,{severity:'warn',component:'admin',eventType:'site_token_changed',namespace,mint,message:`Site token set to ${meta.name||mint} (${mint}); fee wallet ${feeWallet}; funding: ${how}`+(test?`; private test: any holder, mode ${test.mode}`:'')+(meta.exists===false?' — no mint exists at this address yet':'')});
 return{...r,live:!!goLive,settlement,fundingMode:fw.mode,fundingModel,budgetBps:bps,budgetAction,balance:balance==null?null:String(balance),budgetEstimate:estimate==null?null:String(estimate),test,exists:meta.exists,name:meta.name||null,symbol:meta.symbol||null,
  onChain:settlement==='program'&&program&&connection?await primaryChainStatus(connection,program,mint,feeWallet):null,site:await site(db)};
}
/**
 * Check a contract address before (or after) it is set as the REBOUND token: does the mint exist, what is it
 * called, does it trade on a pump.fun market, is that market paired with SOL (the 15 % of launched coins buys it
 * with SOL), who created it, is it already known here. Read-only on chain; every check is kept in the logs.
 */
async function checkToken(db,connection,actor,mintIn){
 const mint=address(mintIn,'token contract'),problems=[];
 const acc=await connection.getParsedAccountInfo(new PublicKey(mint),'confirmed').catch(()=>null);
 if(!acc)fail('RPC_UNAVAILABLE','The Solana RPC could not be read; try again',503);
 const p=acc.value?.data?.parsed,exists=p?.type==='mint';
 const meta=exists?await require('./token-meta.cjs').resolve(connection,mint,{timeoutMs:4000}).catch(()=>null):null;
 const market=exists?await pumpMarket(connection,mint):null;
 let curve=null;
 if(market==='curve'||market==='pool'){try{const PSDK=require('@pump-fun/pump-sdk'),bc=await connection.getAccountInfo(PSDK.bondingCurvePda(new PublicKey(mint)),'confirmed');
  if(bc){const c=PSDK.PUMP_SDK.decodeBondingCurve(bc);const q=c.quoteMint&&!c.quoteMint.equals(PublicKey.default)?c.quoteMint.toBase58():null;
   curve={complete:!!c.complete,creator:c.creator?.toBase58?.()||null,quote:q&&q!=='So11111111111111111111111111111111111111112'?q:'SOL'};}}catch{}}
 const known=(await db.query('SELECT kind,status,namespace FROM reward_coins WHERE mint=$1',[mint])).rows[0]||null;
 if(!exists)problems.push('No token mint exists at this address.');
 else if(market===null)problems.push('It does not trade on a pump.fun bonding curve or PumpSwap pool, so purchases cannot be measured.');
 if(curve&&curve.quote!=='SOL')problems.push('Its market is paired with '+curve.quote+', not SOL: the 15 % of launched coins buys REBOUND with SOL.');
 if(known&&known.kind==='third_party')problems.push('This is a coin launched on rebound, not a separate REBOUND token.');
 const result={mint,exists,name:meta?.name||null,symbol:meta?.symbol||null,image:meta?.image||null,decimals:exists?Number(p.info.decimals):null,supply:exists?String(p.info.supply):null,
  program:acc.value?.owner?.toBase58?.()||null,market:market||null,graduated:curve?curve.complete:market==='pool',creator:curve?.creator||null,quote:curve?.quote||(market?'SOL':null),
  known:known?{kind:known.kind,status:known.status,namespace:known.namespace}:null,ok:problems.length===0,problems,checkedAt:new Date().toISOString(),checkedBy:actor};
 await Logs.log(db,{severity:result.ok?'info':'warn',component:'admin',eventType:'token_checked',mint,
  message:`Token check${result.ok?' OK':' found problems'}: ${result.name||'unnamed'}${result.symbol?' ('+result.symbol+')':''} ${mint}; `+(exists?`${market?'pump.fun '+(result.graduated?'PumpSwap pool':'bonding curve')+', '+result.quote+' pair':'no pump.fun market'}`:'no mint')+(problems.length?' — '+problems.join(' '):''),
  metadata:result});
 return result;
}
/** 'curve' | 'pool' | null — where this mint trades on pump.fun (null also when the RPC cannot tell). */
async function pumpMarket(connection,mint){
 try{const H=require('./history-v3.cjs'),m=H.marketAddresses(mint);
  const [c,p]=await connection.getMultipleAccountsInfo([new PublicKey(m.curve),new PublicKey(m.pool)],'confirmed');
  return c?'curve':p?'pool':null;}catch{return undefined;}
}
/** What the admin wallet still has to sign on chain for this primary (register → start, or fix the fee wallet). */
async function primaryChainStatus(connection,program,mint,feeWallet){
 try{const a=W3.addresses(program,new PublicKey(mint));const [dep,info]=await Promise.all([connection.getAccountInfo(a.deployment,'confirmed'),connection.getAccountInfo(a.coin,'confirmed')]);
  if(!dep)return{deployment:false,next:null};
  const d=W3.decode('deployment',dep.data);
  const c=info&&info.owner.equals(new PublicKey(program))?W3.decode('coin',info.data):null;
  const next=!c?'registerPrimary':c.kind!=='primary'?null:feeWallet&&c.fundingWallet!==feeWallet?'setFundingWallet':!c.active?'startPrimary':null;
  return{deployment:true,admin:d.admin,testMode:d.testMode,paused:d.paused,coin:c?{kind:c.kind,active:c.active,fundingWallet:c.fundingWallet,cycleSeconds:Number(c.cycleSeconds),deposits:String(c.deposits),holderUnallocated:String(c.holderUnallocated),lastCycle:String(c.lastCycle)}:null,next};}
 catch(e){return{error:e.message,next:null};}
}

/**
 * Opening credit request: the part of the dev wallet's balance that counts as funding (split once).
 * The API only records the admin's request; the scheduler (which alone writes funding ledgers)
 * reads the finalized balance and applies it exactly once (worker-v3 applyOpeningRequests).
 */
async function openingCredit(db,actor,{mint,requestedCreditLamports,operationalReserveLamports}){
 mint=address(mint,'mint');const fw=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[mint])).rows[0];if(!fw)fail('NOT_FOUND','Register the primary and its dev wallet first',404);
 if(fw.opening_slot!=null)fail('ALREADY_RECORDED','The opening credit was already recorded for this wallet',409);
 // 'all': the whole finalized balance less the reserve, measured by the scheduler when it applies the request.
 const credit=requestedCreditLamports==='all'?'all':lamports(requestedCreditLamports,'opening credit'),reserve=lamports(operationalReserveLamports,'operational reserve');
 const body={mint,wallet:fw.address,credit:String(credit),reserve:String(reserve),requestedBy:actor};
 await db.query("INSERT INTO reward_intents(id,kind,mint,job,namespace,body,body_hash,amount_lamports,signer_role,state) VALUES($1,'setup',$2,$3,$4,$5,$6,$7,'admin','prepared') ON CONFLICT(kind,job) DO UPDATE SET body=EXCLUDED.body,body_hash=EXCLUDED.body_hash,state='prepared',updated_at=now()",
  [crypto.randomUUID(),mint,`opening:${mint}`,fw.namespace,stable(body),P3.canonicalHash(body),credit==='all'?'0':String(credit)]);
 await audit(db,actor,'admin_opening_credit_requested',body);
 return{...body,state:'requested'};
}
/** Scheduler side: apply pending opening-credit requests against the finalized dev-wallet balance. */
async function applyOpeningRequests(db,connection){
 const rows=(await db.query("SELECT * FROM reward_intents WHERE kind='setup' AND job LIKE 'opening:%' AND state='prepared'")).rows;const out=[];
 for(const r of rows){const b=r.body;
  try{const bal=await connection.getBalanceAndContext(new PublicKey(b.wallet),'finalized');const time=await connection.getBlockTime(bal.context.slot);
   const all=BigInt(bal.value)-BigInt(b.reserve),credit=b.credit==='all'?(all>0n?all:0n):BigInt(b.credit);
   if(credit+BigInt(b.reserve)>BigInt(bal.value)&&b.credit!=='all')throw Object.assign(Error(`The dev wallet holds ${bal.value} lamports`),{code:'INSUFFICIENT_BALANCE'});
   await FS.recordOpening(db,{mint:b.mint,wallet:b.wallet,balance:BigInt(bal.value),requestedCredit:credit,operationalReserve:credit>0n?BigInt(b.reserve):0n,slot:bal.context.slot,time});
   await db.query("UPDATE reward_intents SET state='finalized',updated_at=now() WHERE id=$1",[r.id]);
   await Logs.log(db,{component:'scheduler',eventType:'opening_credit_recorded',mint:b.mint,message:`Opening credit ${credit} lamports`+(b.credit==='all'?' (the whole balance)':'')+` (reserve ${b.reserve}) recorded at finalized slot ${bal.context.slot}; split 85/15 once`});out.push({mint:b.mint,state:'recorded'});}
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

/** Make `wallet` THE administrator wallet: add (or un-revoke) it and revoke every other admin wallet. */
async function setAdminWallet(db,actor,{wallet,label}){
 wallet=address(wallet,'admin wallet');
 await DB.transaction(db,async t=>{
  await t.query('INSERT INTO reward_admin_wallets(wallet,label,added_by) VALUES($1,$2,$3) ON CONFLICT(wallet) DO UPDATE SET revoked_at=NULL,revoked_by=NULL,label=EXCLUDED.label',[wallet,String(label||'owner').slice(0,60),actor]);
  await t.query('UPDATE reward_admin_wallets SET revoked_at=now(),revoked_by=$2 WHERE wallet<>$1 AND revoked_at IS NULL',[wallet,actor]);
 });
 await audit(db,actor,'admin_set_wallet',{wallet});
 await Logs.log(db,{severity:'warn',component:'admin',eventType:'admin_wallet_changed',message:`Administrator wallet set to ${wallet} by ${actor}`});
 return{wallet};
}
async function addAdmin(db,actor,{wallet,label}){wallet=address(wallet,'wallet');await db.query('INSERT INTO reward_admin_wallets(wallet,label,added_by) VALUES($1,$2,$3) ON CONFLICT(wallet) DO UPDATE SET revoked_at=NULL,revoked_by=NULL',[wallet,String(label||'admin').slice(0,60),actor]);await audit(db,actor,'admin_add',{wallet});return{wallet};}
async function revokeAdmin(db,actor,{wallet}){wallet=address(wallet,'wallet');if(wallet===actor)fail('FORBIDDEN','You cannot revoke your own admin wallet',409);
 const left=(await db.query('SELECT count(*)::int n FROM reward_admin_wallets WHERE revoked_at IS NULL AND wallet<>$1',[wallet])).rows[0].n;if(!left)fail('FORBIDDEN','At least one admin must remain',409);
 await db.query('UPDATE reward_admin_wallets SET revoked_at=now(),revoked_by=$2 WHERE wallet=$1',[wallet,actor]);await audit(db,actor,'admin_revoke',{wallet});return{wallet,revoked:true};}

module.exports={checkToken,pumpMarket,primaryChainStatus,budgetBps,setAdminWallet,overview,setMode,testConfig,pause,registerPrimary,site,setSite,launch,tokenMeta,openingCredit,applyOpeningRequests,syncPrimary,chainPrepare,chainSubmit,addAdmin,revokeAdmin,CHAIN_ACTIONS};
