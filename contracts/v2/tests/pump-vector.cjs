'use strict';
// Test-only instruction generator. Inputs contain public addresses/account data.
const fs=require('node:fs'),{PublicKey}=require('@solana/web3.js');
const {TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync}=require('@solana/spl-token');
const AMM=require('@pump-fun/pump-swap-sdk');
const BN=require('@coral-xyz/anchor').BN;
const P=require('../../../server/rewards/pump.cjs'),W=require('../../../server/rewards/wire.cjs');
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const mint=W.pk(input.mint),user=W.pk(input.user),program=W.pk(input.program);
const info=data=>({data:Buffer.from(data,'base64')});
async function main(){
 let instructions;const action=input.action;
 if(action==='create')instructions=(await P.prepareLaunch({program,mint,user,name:'REBOUND local protocol test',symbol:'RTEST',uri:'https://example.org/rebound-fixture.json'})).instructions.slice(1);
 if(action==='sharing'||action==='lock'){const s=await P.sharingSteps(program,mint,input.pool?P.SDK.canonicalPumpPoolPda(mint):null);instructions=[action==='sharing'?s.create:s.lock];}
 if(action==='buy'){
  const b=P.sdk.decodeBondingCurve(info(input.curve)),g=P.sdk.decodeGlobal(info(input.global));
  instructions=await P.sdk.buyV2Instructions({global:g,bondingCurveAccountInfo:info(input.curve),bondingCurve:b,associatedUserAccountInfo:input.existing?info(input.existing):null,mint,user,amount:new BN(input.amount||'1000000000'),quoteAmount:new BN(input.maxQuote||'200000000000'),slippage:0,tokenProgram:TOKEN_2022_PROGRAM_ID});
 }
 if(action==='collect')instructions=await P.collect(mint,user,P.sdk.decodeSharingConfig(info(input.sharing)),{graduated:!!input.graduated});
 if(action==='collectInitial')instructions=[await P.collectInitial(program,mint)];
 if(action==='collectInitialGraduated')instructions=[await P.collectInitialGraduated(program,mint,user)];
 if(action==='migrate'){const g=P.sdk.decodeGlobal(info(input.global));instructions=[await P.sdk.migrateInstruction({withdrawAuthority:g.withdrawAuthority,mint,user,tokenProgram:TOKEN_2022_PROGRAM_ID})];}
 if(action==='ammBuy'){
  const poolInfo=info(input.pool),pool=AMM.PUMP_AMM_SDK.decodePool(poolInfo),globalConfig=AMM.PUMP_AMM_SDK.decodeGlobalConfig(info(input.ammGlobal));
  const state={globalConfig,poolKey:P.SDK.canonicalPumpPoolPda(mint),poolAccountInfo:poolInfo,pool,user,baseTokenProgram:TOKEN_2022_PROGRAM_ID,quoteTokenProgram:TOKEN_PROGRAM_ID,userBaseTokenAccount:getAssociatedTokenAddressSync(mint,user,true,TOKEN_2022_PROGRAM_ID),userQuoteTokenAccount:getAssociatedTokenAddressSync(NATIVE_MINT,user,true,TOKEN_PROGRAM_ID),userBaseAccountInfo:input.existing?{...info(input.existing),owner:TOKEN_2022_PROGRAM_ID}:null,userQuoteAccountInfo:null};
  instructions=await AMM.PUMP_AMM_SDK.buyInstructions(state,new BN('1000000000'),new BN('1000000000'));
 }
 if(!instructions)throw Error('Unknown test action');
 const {Connection}=require('@solana/web3.js');const idl=P.SDK.getPumpProgram(new Connection('http://127.0.0.1:8899')).idl;
 const result=instructions.map(ix=>{const spec=idl.instructions.find(s=>Buffer.from(s.discriminator).equals(ix.data.subarray(0,8)));return{program:ix.programId.toBase58(),data:ix.data.toString('base64'),keys:ix.keys.map(k=>({key:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable})),testExistingFeeRecipients:(spec?.accounts||[]).flatMap((a,i)=>['feeRecipient','buybackFeeRecipient'].includes(a.name)?[ix.keys[i].pubkey.toBase58()]:[])};});
 process.stdout.write(JSON.stringify(result));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
