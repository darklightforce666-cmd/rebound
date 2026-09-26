'use strict';
// Third-party launch, fee routing, receipts and the primary buyback/burn against the REAL Pump,
// PumpSwap and Pump-fees binaries cloned read-only from mainnet (contracts/v3/fixtures/mainnet,
// `node scripts/rewards/clone-protocol.cjs contracts/v3/fixtures/mainnet`), executed in LiteSVM with
// the compiled REBOUND V3 program. Wallets, mints and trades are synthetic and local; nothing here
// touches mainnet. This proves protocol compatibility and on-chain conservation/burn semantics.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),bs58=require('bs58');
const {Keypair,Transaction,PublicKey,ComputeBudgetProgram}=require('@solana/web3.js');
const {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,TOKEN_2022_PROGRAM_ID}=require('@solana/spl-token');
const BN=require('@coral-xyz/anchor').BN;
const W3=require('../../server/rewards/wire-v3.cjs'),P3=require('../../server/rewards/policy-v3.cjs'),PV=require('../../server/rewards/pump-v3.cjs');
const FIX=path.join(__dirname,'../../contracts/v3/fixtures/mainnet'),SO=path.join(__dirname,'../../contracts/v3/target/deploy/rebound_rewards_v3.so');
const ready=fs.existsSync(path.join(FIX,'manifest.json'))&&fs.existsSync(SO);
const t=ready?test:(name,fn)=>test(name,{skip:'needs contracts/v3/fixtures/mainnet (clone-protocol.cjs) and the SBF build'},fn);
const SOL=10n**9n,T0=1_800_000_000;
const sign=(kp,msg)=>crypto.sign(null,msg,crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(kp.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'}));

async function world(){
 const {SvmConnection}=require('./svm-connection.cjs');
 const admin=Keypair.generate(),publisher=Keypair.generate(),verifier=Keypair.generate(),guardian=Keypair.generate(),user=Keypair.generate(),trader=Keypair.generate(),dev=Keypair.generate(),cranker=Keypair.generate();
 const program=Keypair.generate().publicKey,conn=new SvmConnection({program,admin:admin.publicKey}),manifest=conn.loadProtocol(FIX);
 conn.setTime(T0,manifest.programs[0].slot+100);for(const k of [admin,publisher,user,trader,dev,cranker])conn.airdrop(k.publicKey,10_000n*SOL);
 const send=async(ixs,signers)=>{const {blockhash}=await conn.getLatestBlockhash();const tx=new Transaction({feePayer:signers[0].publicKey,recentBlockhash:blockhash}).add(...ixs);tx.sign(...signers);
  try{const sig=await conn.sendRawTransaction(tx.serialize());conn.advance({slots:1,seconds:1});return sig;}catch(e){e.logs=conn.logsOf(bs58.encode(tx.signature));if(process.env.DEBUG_TX)console.log("KEYS",tx.compileMessage().accountKeys.map((k,i)=>i+":"+k.toBase58()).join(" "));throw e;}};
 const fails=async(ixs,signers,pattern)=>{await assert.rejects(send(ixs,signers),e=>{const text=e.message+'\n'+(e.logs||[]).join('\n');assert.match(text,pattern);return true;});};
 await send([W3.I.initialize(program,{admin:admin.publicKey,programData:conn.programData,publisher:publisher.publicKey,verifier:verifier.publicKey,guardian:guardian.publicKey,policy:P3.POLICY_HASH,testMode:false})],[admin]);
 const global=PV.sdk.decodeGlobal(conn._info(PV.SDK.GLOBAL_PDA)),feeConfig=PV.sdk.decodeFeeConfig(conn._info(PV.SDK.PUMP_FEE_CONFIG_PDA));
 const ata=(mint,owner)=>getAssociatedTokenAddressSync(PV.SDK.PUMP_PROGRAM_ID.equals(mint)?mint:mint,owner,true,TOKEN_2022_PROGRAM_ID);
 const buy=async(mint,kp,lamports)=>{const bc=PV.sdk.decodeBondingCurve(conn._info(PV.SDK.bondingCurvePda(mint)));const supply=conn._info(mint).data.readBigUInt64LE(36);
  const q=PV.curveQuote({global,feeConfig,bondingCurve:bc,mintSupply:supply,lamports,slippageBps:300});
  return send([ComputeBudgetProgram.setComputeUnitLimit({units:300_000}),createAssociatedTokenAccountIdempotentInstruction(kp.publicKey,ata(mint,kp.publicKey),kp.publicKey,mint,TOKEN_2022_PROGRAM_ID),await PV.curveBuyExactSolIn({global,mint,user:kp.publicKey,creator:bc.creator,lamports,minOut:q.minOut})],[kp]);};
 const buyOut=async(mint,kp)=>{   // buy the whole remaining curve (graduation)
  const bc=PV.sdk.decodeBondingCurve(conn._info(PV.SDK.bondingCurvePda(mint)));
  const ixs=await PV.sdk.buyV2Instructions({global,bondingCurveAccountInfo:conn._info(PV.SDK.bondingCurvePda(mint)),bondingCurve:bc,associatedUserAccountInfo:conn._info(ata(mint,kp.publicKey)),mint,user:kp.publicKey,amount:bc.realTokenReserves,quoteAmount:new BN(String(500n*SOL)),slippage:0,tokenProgram:TOKEN_2022_PROGRAM_ID});
  await send([ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),...ixs],[kp]);assert.equal(PV.sdk.decodeBondingCurve(conn._info(PV.SDK.bondingCurvePda(mint))).complete,true);};
 const migrate=async(mint,kp)=>{await send([ComputeBudgetProgram.setComputeUnitLimit({units:1_000_000}),await PV.sdk.migrateInstruction({withdrawAuthority:global.withdrawAuthority,mint,user:kp.publicKey,tokenProgram:TOKEN_2022_PROGRAM_ID})],[kp]);};
 const coin=mint=>W3.decode('coin',conn._info(W3.addresses(program,mint).coin).data);
 const job=(mint,id)=>W3.decode('job',conn._info(W3.addresses(program,mint,{job:id}).job).data);
 const supply=mint=>conn._info(mint).data.readBigUInt64LE(36);
 const tokenBalance=acct=>{const i=conn._info(acct);return i?i.data.readBigUInt64LE(64):0n;};
 // PRIMARY: an existing regular Pump coin created by someone else (REBOUND never needs its creator authority).
 const primary=Keypair.generate();
 await send([ComputeBudgetProgram.setComputeUnitLimit({units:300_000}),await PV.sdk.createV2Instruction({mint:primary.publicKey,user:dev.publicKey,name:'Primary token',symbol:'PRIM',uri:'https://rebound.wtf/m/primary.json',creator:dev.publicKey,mayhemMode:false,cashback:false,holderReward:false,quoteMint:PV.SDK.normalizeQuoteMint?require('@solana/spl-token').NATIVE_MINT:require('@solana/spl-token').NATIVE_MINT,creatorFeeBps:new BN(0)})],[dev,primary]);
 await buy(primary.publicKey,trader,5n*SOL);
 await send([W3.I.setBuybackTarget(program,{admin:admin.publicKey,targetMint:primary.publicKey})],[admin]);
 return{conn,program,admin,publisher,verifier,guardian,user,trader,dev,cranker,send,fails,global,feeConfig,buy,buyOut,migrate,coin,job,supply,tokenBalance,ata,primary:primary.publicKey};
}
// Launch a third-party coin exactly as the API prepares it, then route and activate it.
async function launch(w,{initialBuy=500_000_000n}={}){
 const mint=Keypair.generate(),l=await PV.launch({program:w.program,mint:mint.publicKey,user:w.user.publicKey,name:'Third party',symbol:'TPC',uri:'https://rebound.wtf/m/tpc.json',initialBuyLamports:initialBuy,global:w.global});
 const sigs=[];for(const [i,txn] of l.transactions.entries())sigs.push(await w.send(txn,i===0?[w.user,mint]:[w.user]));
 return{mint:mint.publicKey,l,sigs};
}
async function route(w,mint){const r=await PV.routingSteps(w.program,mint,{payer:w.user.publicKey,setup:await PV.setupLamports(w.conn)});await w.send(r.createSteps,[w.user]);await w.send(r.lockSteps,[w.user]);await w.send([r.activate],[w.user]);return r;}
// The verifier's receipt for one finalized collection (amount = measured intake delta).
async function credit(w,mint,collectionSig,amount,path='collect'){
 const slot=await w.conn.getSlot(),dep=W3.addresses(w.program).deployment;
 const a={mint,signature:bs58.decode(collectionSig),instructionPath:W3.hash(path),amount,through:slot-1,issued:slot,expires:slot+10};
 const message=W3.receiptMessage(w.program,dep,a);
 return w.send(W3.credit(w.program,{payer:w.cranker.publicKey,mint,message,verifierSignature:sign(w.verifier,message),verifier:w.verifier.publicKey,event:W3.receiptEvent(a)}),[w.cranker]);
}

t('third-party launch: intake is the creator from the first trade; routing verified before activation; fees collected and split once by verified receipts',async()=>{
 const w=await world();
 const {mint,l}=await launch(w);
 const bc=PV.sdk.decodeBondingCurve(w.conn._info(PV.SDK.bondingCurvePda(mint)));assert.ok(bc.creator.equals(l.addresses.intake),'initial creator = per-mint intake');
 assert.equal(bc.isMayhemMode,false);assert.equal(bc.isCashbackCoin,false);
 const vault=PV.SDK.creatorVaultPda(l.addresses.intake);assert.ok(await w.conn.getBalance(vault)>0,'the creator\'s own initial buy already accrued to the isolated vault');
 await assert.rejects(PV.verifyRouting(w.conn,w.program,mint),e=>e.code==='ROUTING_UNVERIFIED');   // not active before routing
 assert.equal(w.coin(mint).active,false);
 await w.buy(mint,w.trader,2n*SOL);
 await route(w,mint);
 const v=await PV.verifyRouting(w.conn,w.program,mint);assert.equal(v.intake,l.addresses.intake.toBase58());assert.equal(w.coin(mint).active,true);
 // Pre-sharing fees: collected straight from the intake's creator vault into the intake.
 let before=BigInt(await w.conn.getBalance(l.addresses.intake));const s1=await w.send([await PV.collectInitial(w.program,mint)],[w.cranker]);
 const c1=BigInt(await w.conn.getBalance(l.addresses.intake))-before;assert.ok(c1>0n);
 // Post-sharing fees: routed through the mint-scoped sharing config to the intake.
 await w.buy(mint,w.trader,3n*SOL);before=BigInt(await w.conn.getBalance(l.addresses.intake));
 const sc=PV.sdk.decodeSharingConfig(w.conn._info(PV.SDK.feeSharingConfigPda(mint)));
 const s2=await w.send([ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),...await PV.collect({program:w.program,mint,payer:w.cranker.publicKey,sharingConfig:sc})],[w.cranker]);
 const c2=BigInt(await w.conn.getBalance(l.addresses.intake))-before;assert.ok(c2>0n);
 await credit(w,mint,s1,c1);await credit(w,mint,s2,c2);
 const c=w.coin(mint),gross=c1+c2;assert.equal(c.receipts,gross);
 assert.equal(c.holderUnallocated+c.buybackAvailable,gross);assert.ok(c.holderUnallocated*100n>=gross*85n-100n&&c.holderUnallocated*100n<=gross*85n+100n,'85 % holders');
 assert.equal(c.deposits,0n,'third-party funding is receipts, never primary deposits');
 await w.fails(W3.credit(w.program,{payer:w.cranker.publicKey,mint,message:W3.receiptMessage(w.program,W3.addresses(w.program).deployment,{mint,signature:bs58.decode(s1),instructionPath:W3.hash('collect'),amount:c1,through:(await w.conn.getSlot())-1,issued:await w.conn.getSlot(),expires:(await w.conn.getSlot())+5}),verifierSignature:Buffer.alloc(64),verifier:w.verifier.publicKey,event:W3.receiptEvent({signature:bs58.decode(s1),instructionPath:W3.hash('collect'),mint})}),[w.cranker],/index: 0, error: InstructionErrorCustom \{ code: 2 \}/);   // forged attestation: the Ed25519 precompile rejects it
 await assert.rejects(credit(w,mint,s1,c1));   // same receipt twice: refused (receipt PDA exists / funds)
 assert.equal(w.coin(mint).receipts,gross);
});

t('primary buyback on the bonding curve: reserve → validated swap → real burn; slippage keeps the budget; a failed burn retries only the burn',async()=>{
 const w=await world();const {mint}=await launch(w,{initialBuy:0n});await w.buy(mint,w.trader,4n*SOL);await route(w,mint);
 const intake=W3.addresses(w.program,mint).intake;let before=BigInt(await w.conn.getBalance(intake));const s=await w.send([await PV.collectInitial(w.program,mint)],[w.cranker]);
 await credit(w,mint,s,BigInt(await w.conn.getBalance(intake))-before);
 const budget=w.coin(mint).buybackAvailable;assert.ok(budget>0n);
 await w.send([W3.I.reserveBuyback(w.program,{payer:w.cranker.publicKey,publisher:w.publisher.publicKey,mint,job:0,cycle:1,amount:budget,maxSlippageBps:100,maxImpactBps:500})],[w.cranker,w.publisher]);
 const buyer=W3.addresses(w.program,mint,{job:0}).buyer;let j=w.job(mint,0);assert.equal(j.state,'reserved');assert.equal(j.targetMint,w.primary.toBase58());
 // Retargeting the deployment later never changes an existing job.
 const other=Keypair.generate().publicKey;
 const state=await PV.marketState(w.conn,w.primary);assert.equal(state.kind,'curve');
 const m=await PV.buybackMarket({connection:w.conn,payer:w.cranker.publicKey,buyer,targetMint:w.primary,lamports:budget,slippageBps:100,maxImpactBps:500,state});
 await w.send(m.setup,[w.cranker]);
 const swap=minOut=>W3.I.buybackSwap(w.program,{publisher:w.publisher.publicKey,mint,job:0,minOut,market:m.market});
 await w.fails([ComputeBudgetProgram.setComputeUnitLimit({units:600_000}),swap(m.quote.expectedOut*2n)],[w.cranker,w.publisher],/6042|Slippage/);   // price guard
 j=w.job(mint,0);assert.equal(j.state,'reserved');assert.equal(BigInt(await w.conn.getBalance(buyer))>=budget,true,'budget intact after a refused swap');
 const supply0=w.supply(w.primary);
 await w.send([ComputeBudgetProgram.setComputeUnitLimit({units:600_000}),swap(m.quote.minOut)],[w.cranker,w.publisher]);
 j=w.job(mint,0);assert.equal(j.state,'purchased');assert.ok(j.acquired>=m.quote.minOut&&j.spent<=budget&&j.spent>0n);
 assert.equal(w.tokenBalance(m.holding),j.acquired);
 await w.fails([ComputeBudgetProgram.setComputeUnitLimit({units:600_000}),swap(1n)],[w.cranker,w.publisher],/0x13b|Custom\(315\)|custom program error: 0x13b/);   // never buys twice (Buyback)
 // Burn with a wrong holding account fails; the job stays purchased and only the burn is retried.
 await w.fails([W3.I.buybackBurn(w.program,{mint,job:0,holding:w.ata(w.primary,w.trader.publicKey),targetMint:w.primary,tokenProgram:TOKEN_2022_PROGRAM_ID})],[w.cranker],/0x13c|Custom\(316\)/);
 assert.equal(w.job(mint,0).state,'purchased');
 await w.send([W3.I.buybackBurn(w.program,{mint,job:0,holding:m.holding,targetMint:w.primary,tokenProgram:TOKEN_2022_PROGRAM_ID})],[w.cranker]);
 j=w.job(mint,0);assert.equal(j.state,'burned');assert.equal(j.burned,j.acquired);
 assert.equal(w.supply(w.primary),supply0-j.acquired,'real burn: mint supply reduced by exactly the acquired amount');assert.equal(w.tokenBalance(m.holding),0n);
 const c0=w.coin(mint);await w.send([W3.I.closeBuyback(w.program,{payer:w.cranker.publicKey,mint,job:0})],[w.cranker]);
 const c1=w.coin(mint);assert.equal(c1.buybackReserved,0n);assert.equal(c1.buybackSpent,j.spent);assert.equal(c1.buybackAvailable,c0.buybackAvailable+budget-j.spent,'unspent budget returns to the buyback reserve, never to holders');
 assert.equal(c1.holderUnallocated,c0.holderUnallocated);
 await w.send([W3.I.setBuybackTarget(w.program,{admin:w.admin.publicKey,targetMint:mint})],[w.admin]);assert.equal(w.job(mint,0).targetMint,w.primary.toBase58());void other;
});

t('graduated primary: canonical PumpSwap pool via buy_exact_quote_in, then burn; graduated third-party fees still reach the intake',async()=>{
 const w=await world();const {mint}=await launch(w,{initialBuy:0n});await w.buy(mint,w.trader,4n*SOL);await route(w,mint);
 const intake=W3.addresses(w.program,mint).intake;let before=BigInt(await w.conn.getBalance(intake));const s=await w.send([await PV.collectInitial(w.program,mint)],[w.cranker]);
 await credit(w,mint,s,BigInt(await w.conn.getBalance(intake))-before);
 // Graduate the PRIMARY coin and migrate it into its canonical pool.
 await w.buyOut(w.primary,w.trader);
 await assert.rejects(PV.marketState(w.conn,w.primary),e=>e.code==='ROUTING_MIGRATING');   // complete but not migrated: held, no substitute market
 await w.migrate(w.primary,w.cranker);
 const state=await PV.marketState(w.conn,w.primary);assert.equal(state.kind,'pool');
 const budget=w.coin(mint).buybackAvailable;
 await w.send([W3.I.reserveBuyback(w.program,{payer:w.cranker.publicKey,publisher:w.publisher.publicKey,mint,job:0,cycle:1,amount:budget,maxSlippageBps:100,maxImpactBps:500})],[w.cranker,w.publisher]);
 const buyer=W3.addresses(w.program,mint,{job:0}).buyer;
 const m=await PV.buybackMarket({connection:w.conn,payer:w.cranker.publicKey,buyer,targetMint:w.primary,lamports:budget,slippageBps:100,maxImpactBps:500,state});
 await w.send(m.setup,[w.cranker]);const supply0=w.supply(w.primary);
 // The publisher pays the fee here: one signature keeps the 23-account PumpSwap route inside the legacy packet limit.
 await w.send([W3.I.buybackSwap(w.program,{publisher:w.publisher.publicKey,mint,job:0,minOut:m.quote.minOut,market:m.market})],[w.publisher]);
 let j=w.job(mint,0);assert.equal(j.state,'purchased');assert.ok(j.acquired>=m.quote.minOut&&j.spent<=budget);
 await w.send([W3.I.buybackBurn(w.program,{mint,job:0,holding:m.holding,targetMint:w.primary,tokenProgram:TOKEN_2022_PROGRAM_ID})],[w.cranker]);
 j=w.job(mint,0);assert.equal(j.state,'burned');assert.equal(w.supply(w.primary),supply0-j.acquired);
 assert.equal(j.spent,budget,'exact quote in: the whole reserved budget buys PRIMARY');
 await w.send([W3.I.closeBuyback(w.program,{payer:w.cranker.publicKey,mint,job:0})],[w.cranker]);assert.equal(w.job(mint,0).state,'closed');assert.equal(w.coin(mint).buybackReserved,0n);
 // The third-party coin graduates too; its AMM creator fees still reach the same intake.
 await w.buyOut(mint,w.trader);await w.migrate(mint,w.cranker);
 const st=await PV.marketState(w.conn,mint);const ammBuyer=w.trader.publicKey;
 const {NATIVE_MINT,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync:ata2,createAssociatedTokenAccountIdempotentInstruction:mk}=require('@solana/spl-token');
 const ammState={globalConfig:st.globalConfig,poolKey:st.poolKey,poolAccountInfo:st.poolAccountInfo,pool:st.pool,user:ammBuyer,baseTokenProgram:TOKEN_2022_PROGRAM_ID,quoteTokenProgram:TOKEN_PROGRAM_ID,
  userBaseTokenAccount:w.ata(mint,ammBuyer),userQuoteTokenAccount:ata2(NATIVE_MINT,ammBuyer,true,TOKEN_PROGRAM_ID),userBaseAccountInfo:w.conn._info(w.ata(mint,ammBuyer)),userQuoteAccountInfo:null};
 await w.send([ComputeBudgetProgram.setComputeUnitLimit({units:600_000}),...await PV.AMM.PUMP_AMM_SDK.buyInstructions(ammState,new BN('1000000000'),new BN(String(5n*SOL)))],[w.trader]);
 const sc=PV.sdk.decodeSharingConfig(w.conn._info(PV.SDK.feeSharingConfigPda(mint)));before=BigInt(await w.conn.getBalance(intake));
 await w.send([ComputeBudgetProgram.setComputeUnitLimit({units:600_000}),...await PV.collect({program:w.program,mint,payer:w.cranker.publicKey,sharingConfig:sc,graduated:true})],[w.cranker]);
 assert.ok(BigInt(await w.conn.getBalance(intake))>before,'graduated creator fees collected into the per-mint intake');
 void mk;
});

test('launch refuses holder-reward / mayhem / cashback and non-SOL modes and malformed metadata',()=>{
 for(const f of [{isHolderReward:true},{isMayhemMode:true},{isCashbackCoin:true},{quoteMint:Keypair.generate().publicKey}])assert.throws(()=>PV.regular(f),e=>e.code==='ROUTING_UNSUPPORTED');
 assert.doesNotThrow(()=>PV.regular({quoteMint:require('@solana/spl-token').NATIVE_MINT}));
 for(const m of [{name:'',symbol:'A',uri:'https://x'},{name:'x'.repeat(33),symbol:'A',uri:'https://x'},{name:'a',symbol:'x'.repeat(11),uri:'https://x'},{name:'a',symbol:'A',uri:'http://x'}])assert.throws(()=>PV.metadata(m),e=>e.code==='INVALID_METADATA');
});
