'use strict';
// Read-only clone of deployed public program/account fixtures. Never signs/sends.
const fs=require('node:fs/promises'),path=require('node:path');
const {Connection,PublicKey}=require('@solana/web3.js');
const P=require('../../server/rewards/pump.cjs'),W=require('../../server/rewards/wire.cjs');
async function main(){
 const out=path.resolve(process.argv[2]||'contracts/v2/fixtures/mainnet');await fs.mkdir(out,{recursive:true});
 const connection=new Connection(process.env.SOLANA_RPC_URL||'https://api.mainnet-beta.solana.com','finalized');
 const programs=[P.SDK.PUMP_PROGRAM_ID,P.SDK.PUMP_AMM_PROGRAM_ID,P.SDK.PUMP_FEE_PROGRAM_ID,P.SDK.MAYHEM_PROGRAM_ID];
 const accounts=[P.SDK.GLOBAL_PDA,P.SDK.AMM_GLOBAL_PDA,W.pda(P.SDK.PUMP_AMM_PROGRAM_ID,'global_config'),P.SDK.GLOBAL_VOLUME_ACCUMULATOR_PDA,P.SDK.AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,W.pda(P.SDK.PUMP_FEE_PROGRAM_ID,'fee_config',W.key(P.SDK.PUMP_AMM_PROGRAM_ID)),P.SDK.FEE_PROGRAM_GLOBAL_PDA,P.SDK.PUMP_FEE_CONFIG_PDA,P.SDK.getGlobalParamsPda(),P.SDK.getSolVaultPda(),new PublicKey('So11111111111111111111111111111111111111112')];
 const manifest={network:'mainnet-beta',capturedAt:new Date().toISOString(),genesis:await connection.getGenesisHash(),programs:[],accounts:[]};
 for(const id of programs){
  const info=await connection.getAccountInfoAndContext(id,'finalized');if(!info.value?.executable||info.value.data.readUInt32LE()!==2)throw Error('Expected upgradeable deployed program');
  const programData=new PublicKey(info.value.data.subarray(4,36));const pd=await connection.getAccountInfoAndContext(programData,'finalized');
  if(!pd.value||pd.value.data.readUInt32LE()!==3)throw Error('Invalid deployed ProgramData');
  const binary=pd.value.data.subarray(45);const file=id+'.so';await fs.writeFile(path.join(out,file),binary);
  manifest.programs.push({id:id.toBase58(),programData:programData.toBase58(),slot:pd.context.slot,deployedSlot:pd.value.data.readBigUInt64LE(4).toString(),sha256:W.hash(binary).toString('hex'),file});
  console.log('Cloned public program',id.toBase58(),binary.length);
 }
 for(const id of accounts){const info=await connection.getAccountInfoAndContext(id,'finalized');if(!info.value){manifest.accounts.push({id:id.toBase58(),missing:true,slot:info.context.slot});continue;}const v=info.value;manifest.accounts.push({id:id.toBase58(),slot:info.context.slot,lamports:String(v.lamports),owner:v.owner.toBase58(),executable:v.executable,data:v.data.toString('base64'),sha256:W.hash(v.data).toString('hex')});}
 await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));console.log('Read-only protocol fixtures saved:',out);
}
main().catch(e=>{console.error(e.message.replace(/https?:\/\/\S+/g,'[RPC URL]'));process.exitCode=1;});
