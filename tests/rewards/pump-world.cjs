'use strict';
// Shared LiteSVM world with the cloned mainnet Pump/PumpSwap/fee programs and the compiled REBOUND V3
// program (see pump-lifecycle-v3.test.cjs). Synthetic local wallets, mints and trades only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),bs58=require('bs58');
const {Keypair,Transaction,PublicKey,ComputeBudgetProgram}=require('@solana/web3.js');
const {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,TOKEN_2022_PROGRAM_ID}=require('@solana/spl-token');
const BN=require('@coral-xyz/anchor').BN;
const W3=require('../../server/rewards/wire-v3.cjs'),P3=require('../../server/rewards/policy-v3.cjs'),PV=require('../../server/rewards/pump-v3.cjs');
const FIX=path.join(__dirname,'../../contracts/v3/fixtures/mainnet'),SO=path.join(__dirname,'../../contracts/v3/target/deploy/rebound_rewards_v3.so');
const ready=fs.existsSync(path.join(FIX,'manifest.json'))&&fs.existsSync(SO);
const SOL=10n**9n,T0=1_800_000_000;
const sign=(kp,msg)=>crypto.sign(null,msg,crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(kp.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'}));

async function world(){
 const {SvmConnection}=require('./svm-connection.cjs');
 const admin=Keypair.generate(),publisher=Keypair.generate(),verifier=Keypair.generate(),guardian=Keypair.generate(),user=Keypair.generate(),trader=Keypair.generate(),dev=Keypair.generate(),cranker=Keypair.generate();
 const program=Keypair.generate().publicKey,conn=new SvmConnection({program,admin:admin.publicKey}),manifest=conn.loadProtocol(FIX);
 conn.setTime(T0,manifest.programs[0].slot+100);for(const k of [admin,publisher,user,trader,dev,cranker])conn.airdrop(k.publicKey,10_000n*SOL);
 const send=async(ixs,signers)=>{const {blockhash}=await conn.getLatestBlockhash();const tx=new Transaction({feePayer:signers[0].publicKey,recentBlockhash:blockhash}).add(...ixs);tx.sign(...signers);
  try{const sig=await conn.sendRawTransaction(tx.serialize());conn.advance({slots:1,seconds:1});return sig;}catch(e){e.logs=conn.logsOf(bs58.encode(tx.signature));throw e;}};
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

module.exports={ready,world,launch,route,credit,sign,SOL,T0};
