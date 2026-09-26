'use strict';
// Official Pump / PumpSwap integration for REBOUND V3 (spec §5.2, §8.3, §10.3, §13).
// * Launch: V3 PrepareCoin + Pump create_v2 with the per-mint intake PDA as the initial creator in
//   ONE transaction, so fees from the very first trade (including the creator's optional initial
//   buy) accrue to the isolated intake — never to the user's wallet or a shared address.
// * Routing: fee sharing created and locked (admin revoked) with the intake as the single 100 %
//   shareholder, signed by the intake PDA inside the program; Activate re-verifies on chain.
// * Buyback: buy_exact_sol_in (curve) / buy_exact_quote_in (canonical PumpSwap pool) account lists
//   for the program's per-job buyer PDA, with a validated quote, min_out, fees and price impact.
// Regular creator-fee coins only: holder-reward, mayhem and cashback modes are refused.
const SDK=require('@pump-fun/pump-sdk'),AMM=require('@pump-fun/pump-swap-sdk');
const {ComputeBudgetProgram,PublicKey}=require('@solana/web3.js');
const {NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction}=require('@solana/spl-token');
const BN=require('@coral-xyz/anchor').BN;
const W3=require('./wire-v3.cjs');
const sdk=SDK.PUMP_SDK,pk=W3.pk,big=x=>BigInt(x.toString()),bn=x=>new BN(String(x));

function regular(flags={}){
 if(flags.quoteMint&&!pk(flags.quoteMint).equals(NATIVE_MINT)&&!pk(flags.quoteMint).equals(PublicKey.default))throw Object.assign(Error('Only SOL-paired Pump coins are supported'),{code:'ROUTING_UNSUPPORTED'});
 if(flags.isHolderReward||flags.holderReward||flags.isMayhemMode||flags.mayhemMode||flags.isCashbackCoin||flags.cashback)throw Object.assign(Error('Only regular creator-fee coins are supported (holder rewards, mayhem and cashback modes are refused)'),{code:'ROUTING_UNSUPPORTED'});
}
function metadata({name,symbol,uri}){
 if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name)>32)throw Object.assign(Error('Name must be 1–32 bytes'),{code:'INVALID_METADATA'});
 if(typeof symbol!=='string'||!symbol.trim()||Buffer.byteLength(symbol)>10)throw Object.assign(Error('Ticker must be 1–10 bytes'),{code:'INVALID_METADATA'});
 if(typeof uri!=='string'||!/^https:\/\//.test(uri)||Buffer.byteLength(uri)>200)throw Object.assign(Error('Metadata URI must be a stable https URL ≤ 200 bytes'),{code:'INVALID_METADATA'});
}
const bps=(n,b)=>n*BigInt(b)/10000n;
// Legacy transaction size with `signatures` signers (1232-byte packet limit).
function fits(instructions,payer,signatures){const {Transaction}=require('@solana/web3.js');const t=new Transaction({feePayer:pk(payer),recentBlockhash:PublicKey.default.toBase58()}).add(...instructions);
 try{return t.serializeMessage().length+1+64*signatures<=1232;}catch{return false;}}

// ---------------- curve buy (exact SOL in) ----------------
async function curveBuyExactSolIn({global,mint,user,creator,lamports,minOut,tokenProgram=TOKEN_2022_PROGRAM_ID,trackVolume=false}){
 mint=pk(mint);user=pk(user);
 return sdk.offlinePumpProgram.methods.buyExactSolIn(bn(lamports),bn(minOut),{0:!!trackVolume}).accountsPartial({
  feeRecipient:global.feeRecipient,mint,associatedUser:getAssociatedTokenAddressSync(mint,user,true,tokenProgram),user,creatorVault:SDK.creatorVaultPda(pk(creator)),tokenProgram,
 }).remainingAccounts([{pubkey:SDK.bondingCurveV2Pda(mint),isWritable:false,isSigner:false},{pubkey:global.buybackFeeRecipients[0],isWritable:true,isSigner:false}]).instruction();
}
/** Quote a curve purchase of `lamports` (fees included) with the SDK's own fee schedule. */
function curveQuote({global,feeConfig,bondingCurve,mintSupply,lamports,slippageBps}){
 const out=big(SDK.getBuyTokenAmountFromSolAmount({global,feeConfig,mintSupply:mintSupply==null?null:bn(mintSupply),bondingCurve,amount:bn(lamports),quoteMint:NATIVE_MINT}));
 const vq=bondingCurve?big(bondingCurve.virtualQuoteReserves):big(global.initialVirtualQuoteReserves??global.initialVirtualSolReserves);
 const vt=bondingCurve?big(bondingCurve.virtualTokenReserves):big(global.initialVirtualTokenReserves);
 const spotOut=BigInt(lamports)*vt/vq;const impactBps=spotOut>0n?Number((spotOut-out)*10000n/spotOut):10000;   // includes fees; conservative
 return{expectedOut:out,minOut:out-bps(out,slippageBps),impactBps,market:'pump-curve'};
}

// ---------------- launch ----------------
/** Creation transaction: PrepareCoin (V3) + create_v2 (creator = intake PDA) [+ creator's initial buy]. */
async function launch({program,mint,user,name,symbol,uri,initialBuyLamports=0n,global,slippageBps=100,computeUnits=400_000}){
 metadata({name,symbol,uri});mint=pk(mint);user=pk(user);const a=W3.addresses(program,mint);
 const create=await sdk.createV2Instruction({mint,user,name,symbol,uri,creator:a.intake,mayhemMode:false,cashback:false,holderReward:false,quoteMint:NATIVE_MINT,creatorFeeBps:new BN(0)});
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:computeUnits}),W3.I.prepareCoin(program,{payer:user,mint}),create];
 let quote=null;const buy=[];
 if(BigInt(initialBuyLamports)>0n){
  if(!global)throw Error('Pump global state is required to quote an initial buy');
  quote=curveQuote({global,feeConfig:null,bondingCurve:null,mintSupply:null,lamports:BigInt(initialBuyLamports),slippageBps});
  if(quote.minOut<=0n)throw Object.assign(Error('Initial buy too small'),{code:'INVALID_AMOUNT'});
  buy.push(createAssociatedTokenAccountIdempotentInstruction(user,getAssociatedTokenAddressSync(mint,user,true,TOKEN_2022_PROGRAM_ID),user,mint,TOKEN_2022_PROGRAM_ID));
  buy.push(await curveBuyExactSolIn({global,mint,user,creator:a.intake,lamports:initialBuyLamports,minOut:quote.minOut}));
 }
 // One transaction when it fits the packet limit; otherwise creation first, then the initial buy.
 // Either way the creator is already the intake PDA, so no early-trade fee can escape it.
 const transactions=buy.length&&fits([...instructions,...buy],user,2)?[[...instructions,...buy]]:buy.length?[instructions,[ComputeBudgetProgram.setComputeUnitLimit({units:200_000}),...buy]]:[instructions];
 return{transactions,instructions:transactions[0],signers:[['user','mint'],...transactions.slice(1).map(()=>['user'])],addresses:a,initialCreator:a.intake.toBase58(),rewardAsset:'native-SOL',initialBuy:quote};
}

// ---------------- routing (post-launch activation) ----------------
// Pump's fee-sharing config is paid by its creator (the intake PDA). The activation step first moves
// exactly this setup rent from the user to the intake; it is a setup deposit, not creator-fee income,
// and is excluded from third-party credits (only attested collection events are credited).
const SHARING_CONFIG_LEN=1024;
// Measured on the cloned mainnet programs: CreateFeeSharingConfig debits the creator by the config
// rent plus a small protocol-owned account; the margin keeps the intake rent-exempt. Any unused
// remainder stays in the intake as a recorded setup deposit (never credited as income).
const SETUP_MARGIN=500_000n;
async function setupLamports(connection){return BigInt(await connection.getMinimumBalanceForRentExemption(SHARING_CONFIG_LEN))+BigInt(await connection.getMinimumBalanceForRentExemption(0))+SETUP_MARGIN;}
async function routingSteps(program,mint,{graduated=false,payer=null,setup=0n}={}){
 mint=pk(mint);const a=W3.addresses(program,mint),pool=SDK.canonicalPumpPoolPda(mint);
 const create=await sdk.createFeeSharingConfig({creator:a.intake,mint,pool:graduated?pool:null});
 const lock=await sdk.updateFeeSharesV2({authority:a.intake,mint,currentShareholders:[a.intake],newShareholders:[{address:a.intake,shareBps:10000}],quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID});
 if(create.keys.length!==13||lock.keys.length!==20)throw Object.assign(Error('Pump fee-sharing account layout changed; routing refused'),{code:'ROUTING_UNSUPPORTED'});
 const fund=BigInt(setup)>0n?[require('@solana/web3.js').SystemProgram.transfer({fromPubkey:pk(payer),toPubkey:a.intake,lamports:BigInt(setup)})]:[];
 return{
  setupLamports:String(setup),createSteps:[ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),...fund,W3.I.createSharing(program,{mint,official:create})],
  lockSteps:[ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),W3.I.lockSharing(program,{mint,official:lock})],
  create:W3.I.createSharing(program,{mint,official:create}),lock:W3.I.lockSharing(program,{mint,official:lock}),
  activate:W3.I.activate(program,{mint,curve:SDK.bondingCurvePda(mint),sharingConfig:SDK.feeSharingConfigPda(mint)}),
 };
}
/** Independent on-chain verification before a coin is shown as active (spec §13 step 10). */
async function verifyRouting(connection,program,mint,{commitment='finalized'}={}){
 mint=pk(mint);const a=W3.addresses(program,mint),curve=SDK.bondingCurvePda(mint),sharing=SDK.feeSharingConfigPda(mint);
 const r=await connection.getMultipleAccountsInfoAndContext([mint,curve,sharing,a.coin],{commitment});const [m,b,s,c]=r.value;
 const fail=reason=>{throw Object.assign(Error(reason),{code:'ROUTING_UNVERIFIED'});};
 if(!m||!b||!s||!c)fail('Launch accounts are missing');
 if(!m.owner.equals(TOKEN_2022_PROGRAM_ID)&&!m.owner.equals(TOKEN_PROGRAM_ID))fail('Mint has an unexpected token program');
 if(!b.owner.equals(SDK.PUMP_PROGRAM_ID)||!s.owner.equals(SDK.PUMP_FEE_PROGRAM_ID)||!c.owner.equals(pk(program)))fail('Routing accounts have unexpected owners');
 const bc=sdk.decodeBondingCurve(b),sc=sdk.decodeSharingConfig(s),coin=W3.decode('coin',c.data);
 regular({quoteMint:bc.quoteMint,isMayhemMode:bc.isMayhemMode,isCashbackCoin:bc.isCashbackCoin,isHolderReward:bc.isHolderReward});
 if(!bc.creator.equals(sharing))fail('Curve creator is not the per-mint fee-sharing config');
 if(!sc.mint.equals(mint)||!sc.adminRevoked||sc.shareholders.length!==1||!sc.shareholders[0].address.equals(a.intake)||sc.shareholders[0].shareBps!==10000)fail('Fee sharing is not locked to the per-mint intake');
 if(sc.status&&!sc.status.active&&sc.status.active!==undefined)fail('Pump fee sharing is paused');
 if(coin.mint!==mint.toBase58()||coin.kind!=='third_party'||!coin.active)fail('REBOUND coin is not active on chain');
 if(bc.complete){const p=await connection.getAccountInfo(SDK.canonicalPumpPoolPda(mint),commitment);if(!p||!p.owner.equals(SDK.PUMP_AMM_PROGRAM_ID))fail('Graduated canonical pool unavailable');
  const pool=AMM.PUMP_AMM_SDK.decodePool(p);if(!pool.coinCreator.equals(sharing)||!pool.baseMint.equals(mint)||!pool.quoteMint.equals(NATIVE_MINT))fail('Graduated fee destination mismatch');}
 return{slot:r.context.slot,intake:a.intake.toBase58(),sharingConfig:sharing.toBase58(),curve:curve.toBase58(),graduated:bc.complete,policy:coin.policy,anchor:Number(coin.anchor)};
}

// ---------------- creator-fee collection into the intake ----------------
async function collect({program,mint,payer,sharingConfig,graduated=false}){
 mint=pk(mint);payer=pk(payer);const out=[];
 if(graduated)out.push(await sdk.transferCreatorFeesToPumpV2({mint,payer,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID}));
 out.push(await sdk.distributeCreatorFeesV2({mint,payer,sharingConfig,sharingConfigAddress:SDK.feeSharingConfigPda(mint),quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,shouldInitializeAta:false}));
 return out;
}
/** The pre-sharing creator vault (creator = intake) is collected directly into the intake. */
async function collectInitial(program,mint){
 const creator=W3.addresses(program,mint).intake;
 return sdk.offlinePumpProgram.methods.collectCreatorFeeV2().accountsPartial({creator,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID}).instruction();
}

// ---------------- market state of the buyback target ----------------
/** Current canonical market of `targetMint`: the curve before graduation, the canonical pool after. */
async function marketState(connection,targetMint,{commitment='confirmed'}={}){
 targetMint=pk(targetMint);
 const [mintInfo,bcInfo,gInfo,fInfo]=await connection.getMultipleAccountsInfo([targetMint,SDK.bondingCurvePda(targetMint),SDK.GLOBAL_PDA,SDK.PUMP_FEE_CONFIG_PDA],commitment);
 if(!mintInfo||!(mintInfo.owner.equals(TOKEN_PROGRAM_ID)||mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)))throw Object.assign(Error('Target mint unavailable'),{code:'ROUTING_UNSUPPORTED'});
 const tokenProgram=mintInfo.owner,supply=Buffer.from(mintInfo.data).readBigUInt64LE(36);
 if(!bcInfo||!bcInfo.owner.equals(SDK.PUMP_PROGRAM_ID))throw Object.assign(Error('Target is not a Pump coin; no supported route'),{code:'ROUTING_UNSUPPORTED'});
 const bondingCurve=sdk.decodeBondingCurve(bcInfo);regular(bondingCurve);
 if(!bondingCurve.complete)return{kind:'curve',tokenProgram,mintSupply:supply,bondingCurve,global:sdk.decodeGlobal(gInfo),feeConfig:fInfo?sdk.decodeFeeConfig(fInfo):null};
 const poolKey=SDK.canonicalPumpPoolPda(targetMint);
 const [poolInfo,gcInfo,afInfo]=await connection.getMultipleAccountsInfo([poolKey,AMM.GLOBAL_CONFIG_PDA,AMM.PUMP_AMM_FEE_CONFIG_PDA],commitment);
 if(!poolInfo||!poolInfo.owner.equals(AMM.PUMP_AMM_PROGRAM_ID))throw Object.assign(Error('Curve complete but the canonical pool is not live yet'),{code:'ROUTING_MIGRATING'});
 const pool=AMM.PUMP_AMM_SDK.decodePool(poolInfo);
 const [b,q]=await connection.getMultipleAccountsInfo([pool.poolBaseTokenAccount,pool.poolQuoteTokenAccount],commitment);
 return{kind:'pool',tokenProgram,poolKey,poolAccountInfo:poolInfo,pool,globalConfig:AMM.PUMP_AMM_SDK.decodeGlobalConfig(gcInfo),feeConfig:afInfo?AMM.PUMP_AMM_SDK.decodeFeeConfig(afInfo):null,
  baseReserve:Buffer.from(b.data).readBigUInt64LE(64),quoteReserve:Buffer.from(q.data).readBigUInt64LE(64),baseMintAccount:{supply}};
}

// ---------------- buyback market (buyer = per-job PDA) ----------------
/**
 * Build the forwarded account list + validated quote for a buyback of `lamports` of PRIMARY.
 * state: {global, feeConfig, bondingCurve, mintSupply, tokenProgram} for the curve, or
 *        {pool, poolKey, globalConfig, feeConfig, baseReserve, quoteReserve, baseMintAccount, tokenProgram} after graduation.
 * Returns {setup: instructions the fee payer runs first (buyer ATAs), market: account metas, quote}.
 */
async function buybackMarket({connection=null,payer,buyer,targetMint,lamports,slippageBps,maxImpactBps,state}){
 payer=pk(payer);buyer=pk(buyer);targetMint=pk(targetMint);lamports=BigInt(lamports);
 const tokenProgram=pk(state.tokenProgram),holding=getAssociatedTokenAddressSync(targetMint,buyer,true,tokenProgram);
 const setup=[createAssociatedTokenAccountIdempotentInstruction(payer,holding,buyer,targetMint,tokenProgram)];
 // The protocol's per-user volume accumulator is created by the fee payer (operating budget), so the
 // swap never spends the buyback budget on account rent.
 const accumulator=state.pool?AMM.PUMP_AMM_SDK.offlineProgram:sdk.offlinePumpProgram;
 const accKey=PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'),buyer.toBuffer()],accumulator.programId)[0];
 if(!connection||!(await connection.getAccountInfo(accKey)))setup.push(await accumulator.methods.initUserVolumeAccumulator().accountsPartial({payer,user:buyer}).instruction());
 let ix,quote;
 if(!state.pool){
  if(state.bondingCurve.complete)throw Object.assign(Error('Curve complete; use the canonical pool'),{code:'ROUTING_MIGRATING'});
  regular(state.bondingCurve);
  quote=curveQuote({global:state.global,feeConfig:state.feeConfig||null,bondingCurve:state.bondingCurve,mintSupply:state.mintSupply,lamports,slippageBps});
  ix=await curveBuyExactSolIn({global:state.global,mint:targetMint,user:buyer,creator:state.bondingCurve.creator,lamports,minOut:quote.minOut,tokenProgram});
 }else{
  const pool=state.pool,poolKey=pk(state.poolKey);
  if(!poolKey.equals(SDK.canonicalPumpPoolPda(targetMint))||!pool.baseMint.equals(targetMint)||!pool.quoteMint.equals(NATIVE_MINT))throw Object.assign(Error('Not the canonical PumpSwap pool of the target mint'),{code:'ROUTING_UNSUPPORTED'});
  const wsol=getAssociatedTokenAddressSync(NATIVE_MINT,buyer,true,TOKEN_PROGRAM_ID);
  setup.push(createAssociatedTokenAccountIdempotentInstruction(payer,wsol,buyer,NATIVE_MINT,TOKEN_PROGRAM_ID));
  const q=AMM.buyQuoteInput({quote:bn(lamports),slippage:0,baseReserve:bn(state.baseReserve),quoteReserve:bn(state.quoteReserve),virtualQuoteReserves:pool.virtualQuoteReserves||new BN(0),
   globalConfig:state.globalConfig,baseMintAccount:state.baseMintAccount,baseMint:targetMint,coinCreator:pool.coinCreator,creator:pool.creator,feeConfig:state.feeConfig||null,quoteMint:NATIVE_MINT,isMayhemMode:!!pool.isMayhemMode});
  const out=big(q.base),Q=BigInt(state.quoteReserve)+big(pool.virtualQuoteReserves||0),B=BigInt(state.baseReserve);
  const spotOut=lamports*B/Q;quote={expectedOut:out,minOut:out-bps(out,slippageBps),impactBps:spotOut>0n?Number((spotOut-out)*10000n/spotOut):10000,market:'pump-amm:'+poolKey.toBase58()};
  const st={globalConfig:state.globalConfig,poolKey,poolAccountInfo:state.poolAccountInfo,pool,user:buyer,baseTokenProgram:tokenProgram,quoteTokenProgram:TOKEN_PROGRAM_ID,userBaseTokenAccount:holding,userQuoteTokenAccount:wsol,userBaseAccountInfo:null,userQuoteAccountInfo:null};
  const accounts=AMM.PUMP_AMM_SDK.swapAccounts(st);const remaining=[];
  // The SDK picks fee recipients at random; REBOUND fixes them so the prepared setup, the quote and a
  // retried swap all reference the same accounts.
  const gc=state.globalConfig,wsolAta=o=>getAssociatedTokenAddressSync(NATIVE_MINT,o,true,TOKEN_PROGRAM_ID);
  accounts.protocolFeeRecipient=gc.protocolFeeRecipients[0];accounts.protocolFeeRecipientTokenAccount=wsolAta(accounts.protocolFeeRecipient);
  accounts.buybackFeeRecipient=gc.buybackFeeRecipients[0];accounts.buybackFeeRecipientTokenAccount=wsolAta(accounts.buybackFeeRecipient);
  // Protocol-side WSOL accounts the swap would otherwise create at the buyer's expense (e.g. the coin
  // creator vault ATA right after migration): created idempotently by the fee payer (operating cost).
  for(const [ata,owner] of [[accounts.protocolFeeRecipientTokenAccount,accounts.protocolFeeRecipient],[accounts.coinCreatorVaultAta,accounts.coinCreatorVaultAuthority],[accounts.buybackFeeRecipientTokenAccount,accounts.buybackFeeRecipient]])
   if(ata&&owner)setup.push(createAssociatedTokenAccountIdempotentInstruction(payer,ata,owner,NATIVE_MINT,TOKEN_PROGRAM_ID));
  if(!pool.coinCreator.equals(PublicKey.default))remaining.push({pubkey:AMM.poolV2Pda?AMM.poolV2Pda(targetMint):SDK.canonicalPumpPoolPda(targetMint),isWritable:false,isSigner:false});
  remaining.push({pubkey:accounts.buybackFeeRecipient,isWritable:false,isSigner:false},{pubkey:accounts.buybackFeeRecipientTokenAccount,isWritable:true,isSigner:false});
  ix=await AMM.PUMP_AMM_SDK.offlineProgram.methods.buyExactQuoteIn(bn(lamports),bn(quote.minOut),{0:false}).accounts(accounts).remainingAccounts(remaining).instruction();
 }
 if(quote.minOut<=0n)throw Object.assign(Error('Quoted output is zero; buyback held'),{code:'BUYBACK_QUOTE_ZERO'});
 if(quote.impactBps>maxImpactBps)throw Object.assign(Error(`Price impact ${quote.impactBps} bps exceeds ${maxImpactBps} bps; buyback held`),{code:'BUYBACK_IMPACT'});
 return{setup,market:ix.keys,program:ix.programId,holding,quote};
}

module.exports={marketState,SDK,AMM,sdk,fits,regular,metadata,launch,routingSteps,setupLamports,SHARING_CONFIG_LEN,verifyRouting,collect,collectInitial,curveQuote,curveBuyExactSolIn,buybackMarket};
