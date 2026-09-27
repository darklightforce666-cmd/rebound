'use strict';
// Launched tokens with direct settlement (migration 019): the worker side.
//   ensureCreatorWallets — keeps a small pool of fresh creator wallets (keys encrypted with the worker's
//                          master key) that the API assigns to launches.
//   collectFees          — sweeps the token's pump.fun creator vaults (curve and PumpSwap) into its creator
//                          wallet; the income reconciliation then splits every collected lamport 85/15.
//   burn                 — the 15 %: buys the REBOUND token on its market with the creator wallet and burns it
//                          in the same transaction (the guaranteed minimum plus any earlier leftover).
// Every transaction goes through transport-v3 (execution gate, spend caps, persisted before broadcast).
const {Keypair,PublicKey,ComputeBudgetProgram,SystemProgram}=require('@solana/web3.js');
const {getAssociatedTokenAddressSync,createBurnInstruction,createSyncNativeInstruction,createCloseAccountInstruction,NATIVE_MINT,TOKEN_PROGRAM_ID}=require('@solana/spl-token');
const PSDK=require('@pump-fun/pump-sdk');
const PV=require('./pump-v3.cjs'),T=require('./transport-v3.cjs'),Signer=require('./signer.cjs'),Logs=require('./logs.cjs');
const b=x=>BigInt(String(x??0).split('.')[0]);
const POOL_SIZE=3,RESERVATION_SECONDS=900,COLLECT_SECONDS=300,MIN_COLLECT=2_000_000n,MIN_BURN=10_000_000n,BURN_SLIPPAGE_BPS=300,BURN_MAX_IMPACT_BPS=500,WALLET_FLOAT=10_000_000n;

const hasMasterKey=env=>!!(env.REWARDS_SIGNER_MASTER_KEY||env.REWARDS_SIGNER_MASTER_KEY_FILE);
async function ensureCreatorWallets(db,{target=POOL_SIZE,env=process.env,connection=null}={}){
 if(connection)await releaseUnused(db,connection);
 const n=Number((await db.query("SELECT count(*)::int n FROM reward_creator_wallets WHERE status='available'")).rows[0].n);let made=0;
 for(let i=n;i<target;i++){
  const kp=Keypair.generate(),secret=JSON.stringify(Array.from(kp.secretKey));
  const s=await Signer.importSigner(db,{role:'launch_creator',secretText:secret,expectedAddress:kp.publicKey.toBase58(),env});kp.secretKey.fill(0);
  await db.query('INSERT INTO reward_creator_wallets(address,signer) VALUES($1,$2)',[s.address,s.id]);made++;
 }
 return made;
}
/**
 * A reservation whose launch never happened goes back to the pool — only when the chain proves the wallet was
 * never used (no balance, no signatures; every pool wallet starts empty) and any prepared transaction has long
 * expired. A wallet that is (or may be) some coin's creator never returns: one creator vault per token.
 */
async function releaseUnused(db,connection){
 const rows=(await db.query(`SELECT w.address,w.attempt_id FROM reward_creator_wallets w LEFT JOIN reward_launch_attempts a ON a.id=w.attempt_id
  WHERE w.status='reserved' AND w.reserved_at<now()-make_interval(secs=>$1) AND (a.id IS NULL OR a.state IN ('draft','awaiting_creation_signature'))
  AND NOT EXISTS(SELECT 1 FROM reward_chain_attempts c WHERE c.job LIKE 'launch:'||w.attempt_id::text||':%') ORDER BY w.reserved_at LIMIT 5`,[RESERVATION_SECONDS])).rows;
 let n=0;
 for(const r of rows){
  const key=new PublicKey(r.address);
  let bal,sigs;try{[bal,sigs]=await Promise.all([connection.getBalance(key,'confirmed'),connection.getSignaturesForAddress(key,{limit:1},'confirmed')]);}catch{continue;}   // unknown: keep reserved
  if(bal!==0||sigs.length)continue;
  n+=(await db.query("UPDATE reward_creator_wallets SET status='available',attempt_id=NULL,reserved_at=NULL WHERE address=$1 AND status='reserved' AND attempt_id=$2",[r.address,r.attempt_id])).rowCount;
 }
 return n;
}
const settledFor=connection=>async sig=>{if(!sig)return{definitivelyUnsettled:true};const s=(await connection.getSignatureStatuses([sig],{searchTransactionHistory:true})).value[0];
 return s&&s.confirmationStatus==='finalized'&&!s.err?{settled:true,signature:sig,slot:s.slot}:{definitivelyUnsettled:!s};};
// Only a pool creator wallet assigned to exactly this coin, with a launch_creator key, is ever used here.
async function signerOf(db,coin,fw,env){
 const cw=(await db.query("SELECT w.*,s.role FROM reward_creator_wallets w JOIN reward_signers s ON s.id=w.signer WHERE w.address=$1",[fw.address])).rows[0];
 if(!cw||cw.status!=='assigned'||cw.mint!==coin.mint||cw.signer!==fw.signer||cw.role!=='launch_creator')throw Object.assign(Error('Funding wallet is not this token\'s assigned creator wallet'),{code:'SIGNER_MISMATCH'});
 const kp=await Signer.load(db,fw.signer,{env});if(kp.publicKey.toBase58()!==fw.address)throw Object.assign(Error('Creator key does not match its wallet'),{code:'SIGNER_MISMATCH'});return kp;}
/** The income ledger must be open before any fee is swept (else the sweep would become opening balance). */
async function ensureOpening(db,coin,fw){
 if(fw.opening_slot!=null)return true;
 const open=(await db.query("SELECT state FROM reward_intents WHERE kind='setup' AND job=$1",['opening:'+coin.mint])).rows[0];
 if(!open||open.state==='failed')await require('./admin-v3.cjs').openingCredit(db,'worker',{mint:coin.mint,requestedCreditLamports:'0',operationalReserveLamports:'0'}).catch(()=>{});
 return false;
}

/** Sweep creator fees at most every COLLECT_SECONDS, when at least MIN_COLLECT lamports wait. SOL pairs. */
async function collectFees({db,connection,env},coin,fw){
 if(coin.quote_mint)return{state:'skipped',reason:'token_quote_pair'};   // pair-asset fees stay in the vault until pair accounting
 if(!(await ensureOpening(db,coin,fw)))return{state:'waiting_opening'};
 const cw=(await db.query('SELECT collected_at FROM reward_creator_wallets WHERE address=$1',[fw.address])).rows[0];
 if(cw?.collected_at&&Date.now()-new Date(cw.collected_at).getTime()<COLLECT_SECONDS*1000)return{state:'waiting'};
 const mark=()=>db.query('UPDATE reward_creator_wallets SET collected_at=now() WHERE address=$1',[fw.address]);
 const online=new PSDK.OnlinePumpSdk(connection),creator=new PublicKey(fw.address);
 const waiting=b((await online.getCreatorVaultBalanceBothPrograms(creator)).toString());
 if(waiting<MIN_COLLECT){await mark();return{state:'nothing',waiting:String(waiting)};}
 const kp=await signerOf(db,coin,fw,env);
 const ixs=await online.collectCoinCreatorFeeInstructions(creator,creator);
 const r=await T.submit({db,connection,job:`collect:${coin.mint}:${Math.floor(Date.now()/(COLLECT_SECONDS*1000))}`,kind:'collection',signerRole:'launch_creator',feePayer:kp,instructions:ixs,
  readSettlement:settledFor(connection),spend:{namespace:coin.namespace,mint:coin.mint,lamports:'0',fees:'5000',kind:'collection'},context:{waiting:String(waiting)}}).catch(e=>({state:'failed',error:e.message}));
 await mark();
 if(r.state==='submitted'||r.state==='finalized')await Logs.log(db,{component:'scheduler',eventType:'creator_fees_collected',mint:coin.mint,message:`Creator fees swept into the token's creator wallet (${waiting} lamports waiting); split 85/15 once reconciled`,metadata:{signature:r.signature||null}});
 else if(!['dry_run','blocked'].includes(r.state))await Logs.log(db,{severity:'warn',component:'scheduler',eventType:'creator_fee_collection_held',mint:coin.mint,message:'Creator-fee collection not sent: '+(r.reason||r.error||r.state)});
 return r;
}

/**
 * 15 % of the collected fees: buy the REBOUND token and burn it. Budget = the ledger's 15 % share minus
 * everything already spent on burns; never more than the wallet holds above the holders' share and a float.
 */
async function burn({db,connection,env},coin,fw){
 // The burn target is REBOUND as set in the admin dashboard right now (Token contract); the mint stored at
 // launch is only the fallback. A coin never buys itself.
 const site=(await db.query('SELECT primary_mint FROM reward_site WHERE id=1')).rows[0]?.primary_mint||null;
 const targetMint=site||coin.primary_target_mint;
 if(coin.quote_mint||!targetMint||targetMint===coin.mint)return{state:'skipped'};
 // One burn at a time: a buy that may still land blocks the next.
 const open=(await db.query("SELECT * FROM reward_burns WHERE mint=$1 AND state='buying' ORDER BY created_at DESC LIMIT 1",[coin.mint])).rows[0];
 if(open){const at=(await db.query("SELECT * FROM reward_chain_attempts WHERE job=$1 ORDER BY created_at DESC LIMIT 1",[`burn:${open.id}`])).rows[0];
  const r=at?await T.reconcile(db,connection,at,settledFor(connection)):{state:'expired'};
  if(r.state==='finalized'){await db.query("UPDATE reward_burns SET state='burned',burn_signature=$2,buy_signature=$2,updated_at=now() WHERE id=$1",[open.id,at.signature]);await publishBurns(db,coin.mint);}
  else if(r.state==='expired'||r.state==='failed')await db.query("UPDATE reward_burns SET state='failed',reason=$2,updated_at=now() WHERE id=$1",[open.id,r.state]);
  return{state:'reconciled',burn:open.id,chain:r.state};}
 const acc=(await db.query('SELECT other_settled,holder_awaiting_transfer FROM reward_funding_accounts WHERE mint=$1',[coin.mint])).rows[0];if(!acc)return{state:'no_ledger'};
 const spent=b((await db.query("SELECT COALESCE(sum(lamports),0) s FROM reward_burns WHERE mint=$1 AND state<>'failed'",[coin.mint])).rows[0].s);
 const bal=b(await connection.getBalance(new PublicKey(fw.address),'confirmed'));
 let amount=b(acc.other_settled)-spent;const room=bal-WALLET_FLOAT-b(acc.holder_awaiting_transfer);if(room<amount)amount=room;
 if(amount<MIN_BURN)return{state:'waiting',amount:String(amount>0n?amount:0n)};
 const kp=await signerOf(db,coin,fw,env),target=new PublicKey(targetMint);
 const state=await PV.marketState(connection,target);
 const m=await PV.buybackMarket({connection,payer:kp.publicKey,buyer:kp.publicKey,targetMint:target,lamports:amount,slippageBps:BURN_SLIPPAGE_BPS,maxImpactBps:BURN_MAX_IMPACT_BPS,state});
 const ata=getAssociatedTokenAddressSync(target,kp.publicKey,true,state.tokenProgram);
 const before=await connection.getTokenAccountBalance(ata,'confirmed').then(x=>b(x.value.amount)).catch(()=>0n);
 const toBurn=before+m.quote.minOut;   // every token this wallet holds after the buy, at minimum
 const ix=m.instruction;
 // PumpSwap takes wrapped SOL: wrap exactly the budget before the swap, unwrap what is left after the burn.
 const wsol=state.pool?getAssociatedTokenAddressSync(NATIVE_MINT,kp.publicKey,true,TOKEN_PROGRAM_ID):null;
 const wrap=wsol?[SystemProgram.transfer({fromPubkey:kp.publicKey,toPubkey:wsol,lamports:amount}),createSyncNativeInstruction(wsol)]:[];
 const unwrap=wsol?[createCloseAccountInstruction(wsol,kp.publicKey,kp.publicKey)]:[];
 const id=require('node:crypto').randomUUID();
 await db.query('INSERT INTO reward_burns(id,mint,target_mint,lamports,bought_raw,state) VALUES($1,$2,$3,$4,$5,\'buying\')',[id,coin.mint,target.toBase58(),String(amount),String(toBurn)]);
 const r=await T.submit({db,connection,job:`burn:${id}`,kind:'buyback_purchase',signerRole:'launch_creator',feePayer:kp,
  instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),...m.setup,...wrap,ix,createBurnInstruction(ata,target,kp.publicKey,toBurn,[],state.tokenProgram),...unwrap],
  readSettlement:settledFor(connection),spend:{namespace:coin.namespace,mint:coin.mint,lamports:String(amount),fees:'10000',kind:'buyback'},context:{burn:id,expectedOut:String(m.quote.expectedOut),minOut:String(m.quote.minOut)}}).catch(e=>({state:'failed',error:e.message}));
 if(['dry_run','blocked','held','failed'].includes(r.state)){await db.query("UPDATE reward_burns SET state='failed',reason=$2,updated_at=now() WHERE id=$1",[id,String(r.reason||r.error||r.state).slice(0,200)]);return r;}
 await Logs.log(db,{severity:'warn',component:'scheduler',eventType:'buyback_burn_sent',mint:coin.mint,message:`15 %: buying the REBOUND token with ${amount} lamports and burning ${toBurn} raw units in one transaction`,metadata:{signature:r.signature||null}});
 return r;
}
async function publishBurns(db,mint){
 const r=(await db.query("SELECT COALESCE(sum(bought_raw),0)::text s,count(*)::int n FROM reward_burns WHERE mint=$1 AND state='burned'",[mint])).rows[0];
 await db.query('UPDATE reward_public_tokens SET burned_raw=$2,burns=$3 WHERE mint=$1',[mint,r.s,r.n]).catch(()=>{});
}
module.exports={ensureCreatorWallets,releaseUnused,collectFees,burn,ensureOpening,hasMasterKey,POOL_SIZE,MIN_BURN,MIN_COLLECT,RESERVATION_SECONDS};
