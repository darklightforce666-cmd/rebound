'use strict';
// Launchpad without the on-chain program (migration 019). The same journey as launch-v3 — the mint key is
// generated in the user's browser, the server builds the exact transaction, the user signs, the server
// verifies byte-for-byte, persists and broadcasts — but the new coin's pump.fun creator is its own creator
// wallet, held by the worker (encrypted like the fee-wallet key). Nothing needs activation: once the creation
// is finalized and the chain shows that creator, the token is registered with direct settlement and runs the
// same rules as the REBOUND token (income 85/15, rounds, 15-minute maturity, permanent exit on sale); the
// worker collects its creator fees and burns the REBOUND token with the 15 %.
// Pairs: SOL, or a quote asset pump.fun admits (Global whitelist or its QuoteControl list). The pair is
// resolved on chain at prepare time — an arbitrary token can never be chosen.
const bs58=require('bs58');
const {PublicKey,SystemProgram,ComputeBudgetProgram,TransactionInstruction}=require('@solana/web3.js');
const {NATIVE_MINT}=require('@solana/spl-token');
const DB=require('./db.cjs'),PV=require('./pump-v3.cjs'),T=require('./transport-v3.cjs'),P3=require('./policy-v3.cjs'),Logs=require('./logs.cjs'),{stable}=require('./policy.cjs');
const L=require('./launch-v3.cjs'),Meta=require('./token-meta.cjs'),PSDK=require('@pump-fun/pump-sdk'),{BN}=require('@coral-xyz/anchor');
const bn=x=>new BN(String(x));
const fail=(code,message,status=400)=>{throw Object.assign(Error(message),{code,status});};
// SOL the launching user moves to the new creator wallet with the creation: it pays the wallet's own
// network fees (fee collection, payouts) and the REBOUND-token account for the burns. Disclosed.
const OPERATING_LAMPORTS=10_000_000n;
const SOL_KEY=NATIVE_MINT.toBase58();

let quoteCache={at:0,list:null};
// Groups for the pair picker: stablecoins, tokenized stocks, wrapped / bridged coins, and everything else.
function quoteCategory({symbol,name}){
 const s=String(symbol||''),n=String(name||'').toLowerCase();
 if(/^(usdc|usdt|usd1|pyusd|usdg|usds|usde|fdusd|eurc|dai|usdh|usdy|ausd)$/i.test(s)||/\b(usd|dollar|stable|euro)\b/.test(n))return 'stable';
 if(/xstock|tokenized|\bstock\b|\bshares?\b|\betf\b|\bequity\b|\binc\.?\b|\bcorp\b|ondo/.test(n)||/^[A-Z]{1,5}x$/.test(s))return 'stock';
 if(/^(w|cb|z|t|so|x)?(btc|eth|bnb|sui|xrp|doge|ltc|avax|trx|ada|hype)$/i.test(s)||/wrapped|bridged|wormhole|portal|bitcoin|ether/.test(n))return 'wrapped';
 return 'other';
}
/** Quote assets pump.fun admits right now (SOL first), with display names. Cached for 10 minutes. */
async function quoteMints(connection){
 if(quoteCache.list&&Date.now()-quoteCache.at<600000)return quoteCache.list;
 if(quoteCache.failedAt&&Date.now()-quoteCache.failedAt<60000)return quoteCache.list||[{mint:SOL_KEY,symbol:'SOL',name:'Solana',sol:true}];
 const online=new PSDK.OnlinePumpSdk(connection);
 const listed=(await online.fetchSupportedQuoteMints().catch(e=>{quoteCache.failedAt=Date.now();throw e;})).map(e=>e.mint.toBase58()).filter(m=>m!==SOL_KEY&&m!==PublicKey.default.toBase58());
 const unique=[...new Set(listed)];
 const named=[];
 for(let i=0;i<unique.length;i+=100){
  const infos=await connection.getMultipleParsedAccounts(unique.slice(i,i+100).map(m=>new PublicKey(m)),{commitment:'confirmed'}).catch(()=>({value:[]}));
  unique.slice(i,i+100).forEach((m,j)=>{const md=(infos.value?.[j]?.data?.parsed?.info?.extensions||[]).find(e=>e.extension==='tokenMetadata')?.state;
   named.push({mint:m,symbol:md?.symbol?String(md.symbol).slice(0,16):null,name:md?.name?String(md.name).slice(0,48):null,uri:md?.uri?Meta.httpUrl(md.uri):null});});
 }
 // Name, ticker and logo from each asset's own metadata (display only), all at once; then Jupiter's token list for
 // any asset whose metadata has no usable image. Display only.
 const until=Date.now()+7000;
 const image=async uri=>{try{const r=await fetch(uri,{signal:AbortSignal.timeout(3500)});return r.ok?Meta.httpUrl((await r.json())?.image||''):null;}catch{return null;}};
 await Promise.all(named.map(async q=>{try{
  if(q.uri)q.image=await image(q.uri);   // Token-2022: the metadata URI is already known
  else{const m=await Meta.resolve(connection,q.mint,{timeoutMs:3500});if(m){q.symbol=q.symbol||m.symbol||null;q.name=q.name||m.name||null;q.image=m.image||null;}}
 }catch{}}));
 for(const q of named)delete q.uri;
 const missing=named.filter(q=>!q.image||!q.symbol);
 for(let i=0;i<missing.length&&Date.now()<until;i+=50)try{
  const r=await fetch((process.env.JUPITER_API_URL||'https://lite-api.jup.ag').replace(/\/+$/,'')+'/tokens/v2/search?query='+missing.slice(i,i+50).map(q=>q.mint).join(','),{signal:AbortSignal.timeout(3000)});
  if(r.ok)for(const t of await r.json()){const q=missing.find(x=>x.mint===t.id);if(!q)continue;q.image=q.image||Meta.httpUrl(t.icon||'')||null;q.symbol=q.symbol||(t.symbol?String(t.symbol).slice(0,16):null);q.name=q.name||(t.name?String(t.name).slice(0,48):null);}
 }catch{}
 for(const q of named)q.category=quoteCategory(q);
 const list=[{mint:SOL_KEY,symbol:'SOL',name:'Solana',sol:true,category:'sol'},...named.sort((a,b)=>String(a.symbol||'~').localeCompare(String(b.symbol||'~')))];
 // Logos still missing (slow metadata hosts): keep this list one minute only, then try again.
 quoteCache={at:named.some(q=>!q.image)?Date.now()-540000:Date.now(),list};return list;
}

/** 1. Draft: the shared draft plus the pair. The pair is fixed once the launch has been prepared (the prepared
 *  intent is what the user signs; registration reads the pair from it, never from this row). */
async function draft(ports,{quoteMint=null,...args}){
 const a=await L.draft(ports,args);const {db}=ports;
 let q=null;if(quoteMint&&quoteMint!==SOL_KEY){try{q=new PublicKey(quoteMint).toBase58();}catch{fail('QUOTE_MINT_INVALID','Invalid pair asset');}}
 if(q&&BigInt(a.initial_buy_lamports||0)>0n)fail('INITIAL_BUY_SOL_ONLY','An initial buy in the launch transaction is available for SOL pairs only; buy after creation on pump.fun');
 await db.query("UPDATE reward_launch_attempts SET quote_mint=$2,settlement='direct' WHERE id=$1 AND state='draft' AND (settlement IS NULL OR settlement='direct')",[a.id,q]);
 return(await db.query('SELECT * FROM reward_launch_attempts WHERE id=$1',[a.id])).rows[0];
}

// Reservation goes through a database function: the API cannot write creator wallets directly (019).
async function reserveCreator(db,attemptId){
 const address=(await db.query('SELECT reward_reserve_creator_wallet($1) a',[attemptId])).rows[0].a;
 if(!address)fail('LAUNCH_CAPACITY','Launch capacity is being prepared; retry in a minute',503);
 return(await db.query('SELECT * FROM reward_creator_wallets WHERE address=$1',[address])).rows[0];
}

/** 2. The exact creation transaction + disclosure. `mint` is the browser's ephemeral mint public key. */
async function prepare(ports,{session,attemptId,mint}){
 const {db,connection}=ports;const a=await attemptOf(db,attemptId,session.userId);
 if(!['draft','awaiting_creation_signature'].includes(a.state))fail('LAUNCH_STATE',`Launch is ${a.state}`,409);
 try{mint=new PublicKey(mint).toBase58();}catch{fail('MINT_INVALID','Invalid mint public key');}
 if(await connection.getAccountInfo(new PublicKey(mint)))fail('MINT_EXISTS','That mint address is already in use; generate a new one');
 // The metadata's website is this coin's page on rebound.wtf, fixed for the mint chosen before the upload.
 const md=ports.readMetadata?await ports.readMetadata(a.metadata_hash).catch(()=>null):null;
 if(md?.data?.website&&md.data.website!==require('./metadata.cjs').tokenPage(mint))fail('METADATA_MINT_MISMATCH','The token details were prepared for a different mint address. Start the launch again.',409);
 await L.launchAllowed(db,a.namespace,a.wallet);
 const live=(await db.query(`SELECT * FROM reward_chain_attempts WHERE job LIKE $1 AND state IN ${T.LIVE}`,[`launch:${a.id}:%`])).rows[0];
 if(live){const r=await T.reconcile(db,connection,live,async sig=>settled(connection,sig));if(r.state!=='expired'&&r.state!=='failed')fail('LAUNCH_PENDING','The signed creation may still land; wait for it',409);}
 const creator=await reserveCreator(db,a.id);
 const online=new PSDK.OnlinePumpSdk(connection);
 // The pair: SOL, or an admitted quote asset (throws for anything pump.fun does not list).
 let quote=null;if(a.quote_mint){try{quote=await online.resolveQuoteMint(new PublicKey(a.quote_mint));}catch(e){fail('QUOTE_MINT_NOT_ALLOWED','pump.fun does not allow this pair asset: '+String(e.message||e).slice(0,120),409);}}
 const user=new PublicKey(a.wallet),mintKey=new PublicKey(mint),creatorKey=new PublicKey(creator.address);
 const ixs=[ComputeBudgetProgram.setComputeUnitLimit({units:quote?500_000:400_000}),
  SystemProgram.transfer({fromPubkey:user,toPubkey:creatorKey,lamports:OPERATING_LAMPORTS})];
 const buy=BigInt(a.initial_buy_lamports||0);let initialBuy=null,buyTx=null;
 if(quote){
  ixs.push(await PV.sdk.createV2Instruction({mint:mintKey,name:a.name,symbol:a.symbol,uri:a.metadata_uri,creator:creatorKey,user,mayhemMode:false,quoteMint:quote.mint,quoteTokenProgram:quote.quoteTokenProgram}));
 }else if(buy>0n){
  const global=await online.fetchGlobal();
  const tokens=PSDK.getBuyTokenAmountFromSolAmount({global,feeConfig:null,mintSupply:null,bondingCurve:null,amount:bn(buy),quoteMint:NATIVE_MINT});
  const minOut=BigInt(tokens.toString())*97n/100n;   // 3 % slippage for the creator's own first buy
  // Creation and the creator's first buy do not fit one transaction (1232 bytes): the token is created first, and
  // the buy (its token account + buy instruction, built for this mint now) is a second signature right after it.
  const [createIx,...buyIxs]=await PV.sdk.createV2AndBuyInstructions({global,mint:mintKey,name:a.name,symbol:a.symbol,uri:a.metadata_uri,creator:creatorKey,user,amount:bn(minOut),solAmount:bn(buy),mayhemMode:false});
  ixs.push(createIx);buyTx=[ComputeBudgetProgram.setComputeUnitLimit({units:300_000}),...buyIxs];
  initialBuy={lamports:String(buy),minTokens:String(minOut)};
 }else{
  ixs.push(await PV.sdk.createV2Instruction({mint:mintKey,name:a.name,symbol:a.symbol,uri:a.metadata_uri,creator:creatorKey,user,mayhemMode:false}));
 }
 const sim=await L.simulate(connection,ixs,a.wallet);
 if(sim.err)fail('SIMULATION_FAILED','The creation transaction would fail on chain; nothing was signed ('+JSON.stringify(sim.err).slice(0,120)+')',422);
 const bh=await connection.getLatestBlockhash('confirmed');
 const body={mint,creator:creator.address,quoteMint:quote?quote.mint.toBase58():null,transactions:[ixs.map(L.ixJson),...(buyTx?[buyTx.map(L.ixJson)]:[])],blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight};
 await db.query(`INSERT INTO reward_intents(id,kind,mint,job,namespace,body,body_hash,amount_lamports,signer_role,state) VALUES($1,'direct_launch',$2,$3,$4,$5,$6,$7,'creator','awaiting_signature')
  ON CONFLICT(kind,job) DO UPDATE SET body=EXCLUDED.body,body_hash=EXCLUDED.body_hash,mint=EXCLUDED.mint,state='awaiting_signature',updated_at=now()`,
  [require('node:crypto').randomUUID(),mint,`launch:${a.id}`,a.namespace,stable(body),P3.canonicalHash(body),String(buy+OPERATING_LAMPORTS)]);
 await db.query("UPDATE reward_launch_attempts SET state='awaiting_creation_signature',creator_wallet=$2,intake=$2,settlement='direct',updated_at=now() WHERE id=$1",[a.id,creator.address]);
 const pol=P3.policy(a.policy_version),unsigned=unsignedTx(ixs,a.wallet,bh);
 const pair=quote?(await quoteMints(connection).catch(()=>[])).find(x=>x.mint===body.quoteMint)||{mint:body.quoteMint}:{mint:SOL_KEY,symbol:'SOL'};
 return{attemptId:a.id,mint,settlement:'direct',transactions:[unsigned],initialBuyPending:!!buyTx,signers:['mint'],
  disclosure:{creatorWallet:a.wallet,commissionTreasury:creator.address,pair,
   feeRouting:'Every creator fee of this token goes to its own REBOUND creator wallet (held by the REBOUND worker, not by you). Each collected fee is split once: 85 % pays this token\'s holders who are underwater, 15 % buys the REBOUND token and burns it.',
   primaryBurnTarget:a.primary_target_mint,
   policy:{version:a.policy_version,hash:P3.hashOf(pol),cycleSeconds:pol.cycleSeconds,cutoffLeadSeconds:pol.cutoffLeadSeconds,lossUnit:quote?(pair.symbol||'pair asset'):'SOL',maturitySeconds:pol.maturitySeconds,permanentExitOnSale:pol.permanentExitOnSale},
   costs:{operatingLamports:String(OPERATING_LAMPORTS),reboundCoinRentLamports:'0',initialBuyLamports:String(buy),initialBuyQuote:initialBuy,networkFeeLamports:5000*2},
   pairNote:quote?'This coin\'s creator fees arrive in '+(pair.symbol||'the pair asset')+', so its holders are measured and paid in '+(pair.symbol||'it')+'. The 15 % is swapped to SOL and buys and burns REBOUND.':null,
   steps:buyTx?['Create token','Initial buy']:['Create token'],irreversible:['The token\'s pump.fun creator (fee recipient) is fixed to its REBOUND creator wallet.']}};
}
const {Transaction}=require('@solana/web3.js');
const unsignedTx=(ixs,payer,bh)=>new Transaction({feePayer:new PublicKey(payer),blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(...ixs).serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
async function attemptOf(db,id,userId){const a=(await db.query('SELECT * FROM reward_launch_attempts WHERE id=$1',[id])).rows[0];if(!a||a.user_id!==userId)fail('NOT_FOUND','Launch not found',404);return a;}
async function settled(connection,sig){if(!sig)return{definitivelyUnsettled:true};const s=(await connection.getSignatureStatuses([sig],{searchTransactionHistory:true})).value[0];
 return s&&s.confirmationStatus==='finalized'&&!s.err?{settled:true,signature:sig,slot:s.slot}:{definitivelyUnsettled:!s};}

/** 3. The signed creation: verified against the intent, persisted, broadcast. */
/** 2b. The creator's first buy, after the token exists: a fresh unsigned transaction for the prepared buy. */
async function prepareBuy(ports,{session,attemptId}){
 const {db,connection}=ports;const a=await attemptOf(db,attemptId,session.userId);
 const intent=(await db.query("SELECT * FROM reward_intents WHERE kind='direct_launch' AND job=$1",[`launch:${a.id}`])).rows[0];
 if(!intent?.body?.transactions?.[1])fail('PLAN_STALE','No initial buy was prepared for this launch',409);
 if(!a.mint||!(await connection.getAccountInfo(new PublicKey(a.mint))))fail('LAUNCH_STATE','The token does not exist yet',409);
 if((await db.query("SELECT 1 FROM reward_chain_attempts WHERE job=$1",[`launch:${a.id}:1`])).rows.length)fail('LAUNCH_STATE','The initial buy was already submitted',409);
 const bh=await connection.getLatestBlockhash('confirmed');const body={...intent.body,buyBlockhash:bh.blockhash,buyLastValidBlockHeight:bh.lastValidBlockHeight};
 await db.query('UPDATE reward_intents SET body=$2,body_hash=$3,updated_at=now() WHERE id=$1',[intent.id,stable(body),P3.canonicalHash(body)]);
 return{attemptId:a.id,transaction:unsignedTx(body.transactions[1].map(L.ixFrom),a.wallet,bh)};
}

async function submit(ports,{session,attemptId,signedTransaction,index=0}){
 const {db,connection}=ports;const a=await attemptOf(db,attemptId,session.userId);
 if(index===1){
  const intent=(await db.query("SELECT * FROM reward_intents WHERE kind='direct_launch' AND job=$1",[`launch:${a.id}`])).rows[0],body=intent?.body;
  if(!body?.transactions?.[1]||!body.buyBlockhash)fail('PLAN_STALE','Prepare the initial buy first',409);
  let tx;try{tx=Transaction.from(Buffer.from(signedTransaction,'base64'));}catch{fail('INVALID_TRANSACTION','Unsupported transaction encoding');}
  if(!T.matchesIntent(tx,{instructions:body.transactions[1].map(L.ixFrom),signer:a.wallet,blockhash:body.buyBlockhash}))fail('FORBIDDEN','Signed transaction does not match the prepared initial buy',403);
  const r=await T.persistAndBroadcast(db,connection,{job:`launch:${a.id}:1`,kind:'launch',mint:body.mint,signerRole:'creator',intentId:intent.id,bytes:tx.serialize(),signature:bs58.encode(tx.signature),lastValidBlockHeight:body.buyLastValidBlockHeight});
  await Logs.log(db,{component:'launch',eventType:'initial_buy_submitted',mint:body.mint,message:'Creator initial buy signed and submitted',metadata:{signature:r.signature}});
  return{state:r.state,signature:r.signature};
 }
 if(!['awaiting_creation_signature','creation_submitted'].includes(a.state))fail('LAUNCH_STATE',`Launch is ${a.state}`,409);
 const intent=(await db.query("SELECT * FROM reward_intents WHERE kind='direct_launch' AND job=$1",[`launch:${a.id}`])).rows[0];if(!intent)fail('PLAN_STALE','Prepare the launch first',409);
 const body=intent.body;let tx;try{tx=Transaction.from(Buffer.from(signedTransaction,'base64'));}catch{fail('INVALID_TRANSACTION','Unsupported transaction encoding');}
 if(!T.matchesIntent(tx,{instructions:body.transactions[0].map(L.ixFrom),signer:a.wallet,blockhash:body.blockhash}))fail('FORBIDDEN','Signed transaction does not match the prepared launch',403);
 await L.launchAllowed(db,a.namespace,a.wallet);
 const r=await T.persistAndBroadcast(db,connection,{job:`launch:${a.id}:0`,kind:'launch',mint:body.mint,signerRole:'creator',intentId:intent.id,bytes:tx.serialize(),signature:bs58.encode(tx.signature),lastValidBlockHeight:body.lastValidBlockHeight,context:{index:0,direct:true}});
 await db.query("UPDATE reward_launch_attempts SET state='creation_submitted',mint=$2,updated_at=now() WHERE id=$1",[a.id,body.mint]);
 await Logs.log(db,{component:'launch',eventType:'creation_submitted',mint:body.mint,message:'Token creation signed and submitted; waiting for finality',metadata:{signature:r.signature}});
 return{state:r.state,signature:r.signature};
}

/** 4. Reconcile with the chain; register the coin only after finalized evidence. No activation step. */
async function status(ports,{session,attemptId}){
 const {db,connection}=ports;let a=await attemptOf(db,attemptId,session.userId);
 if(a.state==='creation_submitted'){
  const at=(await db.query("SELECT * FROM reward_chain_attempts WHERE job=$1 ORDER BY created_at DESC LIMIT 1",[`launch:${a.id}:0`])).rows[0];
  const r=at?(at.state==='finalized'?{state:'finalized',signature:at.signature}:await T.reconcile(db,connection,at,async sig=>settled(connection,sig))):{state:'expired'};
  if(r.state==='expired'||r.state==='failed'){await db.query("UPDATE reward_launch_attempts SET state='draft',mint=NULL,updated_at=now() WHERE id=$1",[a.id]);await Logs.log(db,{severity:'warn',component:'launch',eventType:'creation_expired',message:'Token creation did not land; no token exists. Prepare it again.'});}
  else if(r.state==='finalized')await register(ports,a,at.signature);
  a=await attemptOf(db,attemptId,session.userId);
 }
 return{attemptId:a.id,state:a.state,activationState:a.activation_state,mint:a.mint,intake:a.intake,settlement:'direct',quoteMint:a.quote_mint||null,
  rewards:a.state!=='active'?null:'active'};
}
async function register(ports,a,signature){
 const {db,connection}=ports,mint=new PublicKey(a.mint);
 // The creator and the pair come from the prepared intent the user signed (submit verified the bytes).
 const intent=(await db.query("SELECT body FROM reward_intents WHERE kind='direct_launch' AND job=$1",[`launch:${a.id}`])).rows[0];
 if(!intent||intent.body.mint!==a.mint)fail('SETUP_REQUIRED','The prepared launch is missing',500);
 const creatorWallet=intent.body.creator,quoteMint=intent.body.quoteMint||null;
 const [m,bc]=await connection.getMultipleAccountsInfo([mint,PV.SDK.bondingCurvePda(mint)],'finalized');
 if(!m||!bc)return;   // not yet visible at finalized commitment
 const curve=PV.sdk.decodeBondingCurve(bc);
 const chainQuote=curve.quoteMint&&!curve.quoteMint.equals(PublicKey.default)&&!curve.quoteMint.equals(NATIVE_MINT)?curve.quoteMint.toBase58():null;
 if(!curve.creator.equals(new PublicKey(creatorWallet))||(curve.quoteMint!==undefined&&chainQuote!==quoteMint)){
  await db.query("UPDATE reward_launch_attempts SET state='failed_action_required',activation_state='failed_action_required',updated_at=now() WHERE id=$1 AND state='creation_submitted'",[a.id]);return;}
 const cw=(await db.query('SELECT * FROM reward_creator_wallets WHERE address=$1',[creatorWallet])).rows[0];if(!cw||cw.attempt_id!==a.id)fail('SETUP_REQUIRED','Creator wallet record missing',500);
 const pol=P3.policy(a.policy_version),hash=(await db.query('SELECT hash FROM reward_policies WHERE version=$1',[a.policy_version])).rows[0].hash;
 const st=await connection.getSignatureStatuses([signature],{searchTransactionHistory:true});const slot=st.value[0]?.slot??null,time=slot?await connection.getBlockTime(slot):Math.floor(Date.now()/1000);
 // Every pair pays from the first round: a SOL coin in SOL, a coin paired with another asset in that asset.
 const coinStatus='active',rewardStatus='active';
 let qa=null;if(quoteMint){const p=await connection.getParsedAccountInfo(new PublicKey(quoteMint),'confirmed');const info=p.value?.data?.parsed?.info;
  const listed=(await quoteMints(connection).catch(()=>[])).find(x=>x.mint===quoteMint);
  qa={program:p.value?.owner?.toBase58()||null,decimals:info?.decimals??null,symbol:listed?.symbol||null};}
 let fresh=false;
 await DB.transaction(db,async t=>{
  // Two status polls may race: the attempt row lock makes the second one a no-op.
  const cur=(await t.query('SELECT state FROM reward_launch_attempts WHERE id=$1 FOR UPDATE',[a.id])).rows[0];if(cur?.state!=='creation_submitted')return;
  fresh=true;
  await t.query("UPDATE reward_launch_attempts SET creator_wallet=$2,intake=$2,quote_mint=$3 WHERE id=$1",[a.id,creatorWallet,quoteMint]);
  if(!(await t.query('SELECT reward_assign_creator_wallet($1,$2) ok',[a.id,a.mint])).rows[0].ok)fail('SETUP_REQUIRED','Creator wallet could not be assigned',500);
  await t.query(`INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version,intake,creator_wallet,creator_user,name,symbol,image_uri,metadata_uri,launch_signature,launch_time,launch_slot,schedule_anchor,cycle_seconds,cutoff_lead_seconds,primary_target_mint,token_program,quote_mint,quote_token_program,quote_decimals,quote_symbol)
   VALUES($1,$2,$20,'third_party',$3,'v3',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13,$15,$16,$17,$18,$19,$21,$22,$23) ON CONFLICT(mint) DO NOTHING`,
   [a.mint,hash,a.namespace,a.policy_version,creatorWallet,a.wallet,a.user_id,a.name,a.symbol,a.image_uri,a.metadata_uri,signature,time,slot,pol.cycleSeconds,pol.cutoffLeadSeconds,a.primary_target_mint,m.owner.toBase58(),quoteMint,coinStatus,qa?.program||null,qa?.decimals??null,qa?.symbol||null]);
  if(!(await t.query("SELECT 1 FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[a.mint])).rows[0])
   await t.query(`INSERT INTO reward_funding_wallets(id,namespace,mint,address,mode,signer,ownership_proof,operational_reserve_lamports,status,funding_model)
    VALUES($1,$2,$3,$4,'automatic',$5,$6,$7,'active','income')`,[require('node:crypto').randomUUID(),a.namespace,a.mint,creatorWallet,cw.signer,stable({generatedBy:'worker',attempt:a.id}),'0']);
  await t.query("UPDATE reward_launch_attempts SET state='active',activation_state='active',updated_at=now() WHERE id=$1",[a.id]);
  await t.query(`INSERT INTO reward_public_tokens(mint,namespace,kind,name,symbol,image_uri,creator_wallet,launch_time,reward_status,pinned,test,quote_mint,quote_symbol,quote_decimals)
   VALUES($1,$2,'third_party',$3,$4,$5,$6,$7,$10,false,$8,$9,$11,$12) ON CONFLICT(mint) DO NOTHING`,[a.mint,a.namespace,a.name,a.symbol,a.image_uri,a.wallet,time,a.namespace==='mainnet_test',quoteMint,rewardStatus,qa?.symbol||null,qa?.decimals??null]);
  // Private test: the new token may pay any of its holders (spend caps still apply).
  if(a.namespace==='mainnet_test')await t.query("UPDATE reward_platform SET test_allowlist_mints=array_append(test_allowlist_mints,$1),updated_at=now() WHERE namespace='mainnet_test' AND NOT ($1=ANY(test_allowlist_mints))",[a.mint]);
 },{serializable:false});
 if(!fresh)return;
 // The income ledger starts at the creation: only fees collected after it count (the operating SOL does not).
 // If this request fails, the worker files it again before any fee is collected.
 await require('./admin-v3.cjs').openingCredit(db,'launch:'+a.wallet,{mint:a.mint,requestedCreditLamports:'0',operationalReserveLamports:'0'})
  .catch(e=>Logs.log(db,{severity:'warn',component:'launch',eventType:'opening_request_deferred',mint:a.mint,message:'Income ledger opening deferred to the worker: '+e.message}));
 await Logs.log(db,{severity:'warn',component:'launch',eventType:'token_created',mint:a.mint,message:quoteMint
  ?`Token created on pump.fun (pair ${qa?.symbol||quoteMint}) with its REBOUND creator wallet ${creatorWallet}; rewards are active in ${qa?.symbol||'the pair asset'} (85 % holders, 15 % swapped to SOL for the REBOUND buy & burn)`
  :`Token created on pump.fun with its REBOUND creator wallet ${creatorWallet}; rewards are active (85 % holders, 15 % REBOUND buy & burn)`});
}
module.exports={draft,prepare,prepareBuy,submit,status,quoteMints,quoteCategory,OPERATING_LAMPORTS,register};
