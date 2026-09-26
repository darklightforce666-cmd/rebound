'use strict';
// Third-party launch, fee routing, receipts and the primary buyback/burn against the REAL Pump,
// PumpSwap and Pump-fees binaries cloned read-only from mainnet (contracts/v3/fixtures/mainnet,
// `node scripts/rewards/clone-protocol.cjs contracts/v3/fixtures/mainnet`), executed in LiteSVM with
// the compiled REBOUND V3 program. Wallets, mints and trades are synthetic and local; nothing here
// touches mainnet. This proves protocol compatibility and on-chain conservation/burn semantics.
const test=require('node:test'),assert=require('node:assert/strict'),bs58=require('bs58');
const {Keypair,ComputeBudgetProgram}=require('@solana/web3.js');
const {TOKEN_2022_PROGRAM_ID}=require('@solana/spl-token');
const BN=require('@coral-xyz/anchor').BN;
const W3=require('../../server/rewards/wire-v3.cjs'),PV=require('../../server/rewards/pump-v3.cjs');
const {ready,world,launch,route,credit,SOL}=require('./pump-world.cjs');
const t=ready?test:(name,fn)=>test(name,{skip:'needs contracts/v3/fixtures/mainnet (clone-protocol.cjs) and the SBF build'},fn);

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
