'use strict';
// Converts real LiteSVM execution evidence to the same parsed RPC envelope.
// Only presentation is synthetic; instructions and balances are captured SBF.
const bs58=require('bs58'),W=require('../../server/rewards/wire.cjs');
const TOKEN=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
function parsedInstruction(row){
 const d=Buffer.from(row.data64,'base64'),a=row.accounts,out={programId:row.programId,accounts:a,data:bs58.encode(d),stackHeight:row.stackHeight};
 const set=(type,info)=>{out.parsed={type,info};delete out.data;};
 if(row.programId==='11111111111111111111111111111111'&&d.readUInt32LE()===2)set('transfer',{source:a[0],destination:a[1],lamports:Number(d.readBigUInt64LE(4))});
 if(TOKEN.has(row.programId)){
  const tag=d[0];
  if(tag===1)set('initializeAccount',{account:a[0],mint:a[1],owner:a[2]});
  else if([16,18].includes(tag))set(tag===16?'initializeAccount2':'initializeAccount3',{account:a[0],mint:a[1],owner:W.pk(d.subarray(1,33)).toBase58()});
  else if(tag===3)set('transfer',{source:a[0],destination:a[1],amount:String(d.readBigUInt64LE(1)),authority:a[2]});
  else if(tag===12)set('transferChecked',{source:a[0],mint:a[1],destination:a[2],tokenAmount:{amount:String(d.readBigUInt64LE(1)),decimals:d[9]},authority:a[3]});
  else if(tag===9)set('closeAccount',{account:a[0],destination:a[1],owner:a[2]});
  else if(tag===17)set('syncNative',{account:a[0]});
  else if([0,20].includes(tag))set('initializeMint',{mint:a[0]});
  else if([7,14].includes(tag))set('mintTo',{mint:a[0],account:a[1]});
  else if(tag===6)set('setAuthority',{account:a[0],authorityType:['mintTokens','freezeAccount','accountOwner','closeAccount'][d[1]],newAuthority:d[2]?W.pk(d.subarray(3,35)).toBase58():null});
  else set('captureUnhandled',{tag});
 }return out;
}
function transaction(row){
 const balances=accounts=>accounts.flatMap((a,accountIndex)=>{if(!a||!TOKEN.has(a.owner)||!a.data)return[];const b=Buffer.from(a.data,'base64');if(b.length<165)return[];return[{accountIndex,mint:W.pk(b.subarray(0,32)).toBase58(),owner:W.pk(b.subarray(32,64)).toBase58(),uiTokenAmount:{amount:String(b.readBigUInt64LE(64)),decimals:6}}];});
 return{slot:row.slot,blockTime:row.time,transaction:{signatures:[row.signature],message:{accountKeys:row.keys,instructions:row.instructions.map(parsedInstruction)}},meta:{err:null,preBalances:row.before.map(a=>a?.lamports||0),postBalances:row.after.map(a=>a?.lamports||0),preTokenBalances:balances(row.before),postTokenBalances:balances(row.after),innerInstructions:row.innerInstructions.map(g=>({index:g.index,instructions:g.instructions.map(parsedInstruction)})),logMessages:row.logs}};
}
module.exports={parsedInstruction,transaction};
