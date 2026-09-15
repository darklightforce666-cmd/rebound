'use strict';
const SDK=require('@pump-fun/pump-sdk');
const {NATIVE_MINT,TOKEN_PROGRAM_ID}=require('@solana/spl-token');
const {Transaction,SystemProgram,PublicKey,Connection}=require('@solana/web3.js');
const BN=require('@coral-xyz/anchor').BN;
const W=require('./wire.cjs');
const sdk=SDK.PUMP_SDK;
function solMode(options={}){
 if(options.quoteMint&&!W.pk(options.quoteMint).equals(NATIVE_MINT))throw Error('Only SOL-paired launches are supported');
 if(options.holderReward||options.mayhemMode||options.cashback)throw Error('Use a regular creator-fee coin; holder rewards, mayhem and cashback modes are unsupported');
}
function transaction(instructions,payer,blockhash){const tx=new Transaction({feePayer:W.pk(payer),recentBlockhash:blockhash}).add(...instructions);const b=tx.serialize({requireAllSignatures:false,verifySignatures:false});if(b.length>1232)throw Error('Transaction exceeds Solana packet limit');return{tx,bytes:b.length};}
async function prepareLaunch({program,mint,user,name,symbol,uri,creatorFeeBps=0,...options}){
 solMode(options);mint=W.pk(mint);user=W.pk(user);if(!name||Buffer.byteLength(name)>32||!symbol||Buffer.byteLength(symbol)>10||!/^https:\/\//.test(uri)||Buffer.byteLength(uri)>200)throw Error('Invalid persistent token metadata');
 // SOL uses Pump's dynamic fee schedule. Zero selects its default, not a
 // zero-fee promise; each actual purchase must prove nonzero creator accrual.
 if(creatorFeeBps!==0)throw Error('Custom creator-fee rates are unsupported for SOL launches');
 const a=W.addresses(program,mint);
 const create=await sdk.createV2Instruction({mint,user,name,symbol,uri,creator:a.intake,mayhemMode:false,cashback:false,holderReward:false,quoteMint:NATIVE_MINT,creatorFeeBps:new BN(creatorFeeBps)});
 return{addresses:a,instructions:[W.prepare(program,user,mint),create],initialCreator:a.intake.toBase58(),rewardAsset:'native-SOL'};
}
async function sharingSteps(program,mint,pool=null){
 mint=W.pk(mint);const a=W.addresses(program,mint),canonical=SDK.canonicalPumpPoolPda(mint);
 if(pool&&!W.pk(pool).equals(canonical))throw Error('Noncanonical pool enrollment rejected');
 const create=await sdk.createFeeSharingConfig({creator:a.intake,mint,pool:pool?canonical:null});
 const lock=await sdk.updateFeeSharesV2({authority:a.intake,mint,currentShareholders:[a.intake],newShareholders:[{address:a.intake,shareBps:10000}],quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID});
 if(create.keys.length!==13||lock.keys.length!==20)throw Error('Pinned Pump instruction account layout changed');
 return{create:W.sharing(program,mint,create,false),lock:W.sharing(program,mint,lock,true),activate:W.activate(program,mint,SDK.bondingCurvePda(mint),SDK.feeSharingConfigPda(mint)),official:{create,lock}};
}
async function verifyRouting(connection,program,mint){
 mint=W.pk(mint);const a=W.addresses(program,mint),curve=SDK.bondingCurvePda(mint),sharing=SDK.feeSharingConfigPda(mint);
 const result=await connection.getMultipleAccountsInfoAndContext([mint,curve,sharing],{commitment:'finalized'});const [m,b,s]=result.value;
 if(!m||!b||!s||!b.owner.equals(SDK.PUMP_PROGRAM_ID)||!s.owner.equals(SDK.PUMP_FEE_PROGRAM_ID))throw Error('Launch accounts are missing or have incorrect owners');
 const bc=sdk.decodeBondingCurve(b),sc=sdk.decodeSharingConfig(s);
 solMode({quoteMint:SDK.normalizeQuoteMint(bc.quoteMint),mayhemMode:bc.isMayhemMode,cashback:bc.isCashbackCoin,holderReward:bc.isHolderReward});
 if(!bc.creator.equals(sharing)||!sc.mint.equals(mint)||!sc.adminRevoked||sc.shareholders.length!==1||!sc.shareholders[0].address.equals(a.intake)||sc.shareholders[0].shareBps!==10000)throw Error('Fee destination is not the finalized per-coin intake');
 if(!sc.status.active)throw Error('Pump fee sharing is paused');
 if(bc.complete){const pool=await connection.getAccountInfo(SDK.canonicalPumpPoolPda(mint),'finalized');if(!pool||!pool.owner.equals(SDK.PUMP_AMM_PROGRAM_ID))throw Error('Graduated canonical pool unavailable');const state=SDK.getPumpAmmProgram(connection).coder.accounts.decode('pool',pool.data);if(!state.coinCreator.equals(sharing)||!state.baseMint.equals(mint)||!state.quoteMint.equals(NATIVE_MINT))throw Error('Graduated fee destination mismatch');}
 return{slot:result.context.slot,curve:bc,sharing:sc,addresses:a};
}
async function collect(mint,payer,sharing,{graduated=false}={}){
 mint=W.pk(mint);payer=W.pk(payer);const instructions=[];
 if(graduated)instructions.push(await sdk.transferCreatorFeesToPumpV2({mint,payer,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID}));
 instructions.push(await sdk.distributeCreatorFeesV2({mint,payer,sharingConfig:sharing,sharingConfigAddress:SDK.feeSharingConfigPda(mint),quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,shouldInitializeAta:false}));return instructions;
}
async function collectInitial(program,mint){
 const creator=W.addresses(program,mint).intake;
 // Permissionless direct collection of the isolated pre-sharing creator vault.
 // Its owner remains System Program, even after the curve points to sharing.
 return SDK.getPumpProgram(new Connection('http://127.0.0.1:8899')).methods.collectCreatorFeeV2().accountsPartial({creator,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID}).instruction();
}
async function collectInitialGraduated(program,mint,payer){const creator=W.addresses(program,mint).intake;return SDK.getPumpAmmProgram(new Connection('http://127.0.0.1:8899')).methods.transferCreatorFeesToPumpV2().accountsPartial({payer:W.pk(payer),quoteMint:NATIVE_MINT,tokenProgram:TOKEN_PROGRAM_ID,coinCreator:creator}).instruction();}
module.exports={SDK,sdk,solMode,transaction,prepareLaunch,sharingSteps,verifyRouting,collect,collectInitial,collectInitialGraduated};
