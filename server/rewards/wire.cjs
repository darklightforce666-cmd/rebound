'use strict';
// Exact Borsh wire format for contracts/v2. No keys or trusted browser amounts.
const crypto = require('node:crypto');
const {PublicKey, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Ed25519Program} = require('@solana/web3.js');
const pk = x => x instanceof PublicKey ? x : new PublicKey(x);
const key = x => pk(x).toBuffer();
const u64 = x => { const n=BigInt(x); if(n<0n||n>0xffffffffffffffffn)throw Error('u64 overflow');const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b; };
const u32 = x => {if(!Number.isSafeInteger(Number(x))||x<0||x>0xffffffff)throw Error('u32 overflow');const b=Buffer.alloc(4);b.writeUInt32LE(Number(x));return b;};
const hash = (...x) => crypto.createHash('sha256').update(Buffer.concat(x.map(v=>typeof v==='string'?Buffer.from(v):v))).digest();
const bytes32 = x => {const b=Buffer.isBuffer(x)?x:Buffer.from(x,'hex');if(b.length!==32)throw Error('Expected 32 bytes');return b;};
const pda = (p,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(x=>typeof x==='string'?Buffer.from(x):x),pk(p))[0];
const addresses=(program,mint,round=0n,wallet,index=0,event)=>{
 const deployment=pda(program,'deployment-v2'),coin=pda(program,'coin-v2',key(mint));
 const r=pda(program,'round-v2',key(coin),u64(round));
 return {deployment,coin,intake:pda(program,'intake-v2',key(mint)),round:r,
 position:wallet?pda(program,'position-v2',key(coin),key(wallet)):undefined,
 allocation:pda(program,'award-v2',key(r),u32(index)),receipt:event?pda(program,'receipt-v2',key(coin),bytes32(event)):undefined};
};
const meta=(k,w=false,s=false)=>({pubkey:pk(k),isWritable:w,isSigner:s});
const ix=(program,tag,keys,...data)=>new TransactionInstruction({programId:pk(program),keys,data:Buffer.concat([Buffer.from([tag]),...data])});
const leaf=(c,a)=>({hash:hash('REBOUND:leaf:v2',key(c.program),key(c.deployment),key(c.mint),Buffer.from([0]),bytes32(c.policy),u64(c.round),u32(a.index),key(a.wallet),u64(a.amount)),sum:BigInt(a.amount)});
const parent=(a,b)=>{if(Buffer.compare(a.hash,b.hash)>0||(a.hash.equals(b.hash)&&a.sum>b.sum))[a,b]=[b,a];return{hash:hash('REBOUND:node:v2',a.hash,u64(a.sum),b.hash,u64(b.sum)),sum:BigInt(a.sum)+BigInt(b.sum)};};
function tree(context,allocations){
 if(!allocations.length||allocations.length>65536)throw Error('Invalid manifest size');
 const ids=new Set();for(const a of allocations){if(ids.has(a.index)||BigInt(a.amount)<=0n)throw Error('Duplicate or empty allocation');ids.add(a.index);}
 const levels=[allocations.map(a=>leaf(context,a))];
 // Promote odd nodes unchanged: no duplicated liability for padding.
 while(levels.at(-1).length>1){const l=levels.at(-1),n=[];for(let i=0;i<l.length;i+=2)n.push(l[i+1]?parent(l[i],l[i+1]):l[i]);levels.push(n);}
 return {root:levels.at(-1)[0],allocations:allocations.map((a,i)=>{const proof=[];for(let k=0;k<levels.length-1;k++){const sibling=levels[k][i^1];if(sibling)proof.push(sibling);i=Math.floor(i/2);}return{...a,proof};})};
}
function verifyProof(c,a,root){let n=leaf(c,a);for(const s of a.proof)n=parent(n,{hash:bytes32(s.hash),sum:BigInt(s.sum)});return n.hash.equals(bytes32(root.hash))&&n.sum===BigInt(root.sum);}
function receiptMessage(a){
 const signature=Buffer.from(a.signature);if(signature.length!==64)throw Error('Receipt signature length');
 return Buffer.concat([Buffer.from('RBD2RCPT'),key(a.program),key(a.deployment),key(a.mint),Buffer.from([0]),signature,bytes32(a.instructionPath),u64(a.amount),u64(a.through),u64(a.issued),u64(a.expires)]);
}
const receiptEvent=a=>hash('REBOUND:receipt:v2',Buffer.from(a.signature),bytes32(a.instructionPath),key(a.mint));
function paymentMessage(a){return Buffer.concat([Buffer.from(a.domain||'RBD2PAY0'),key(a.program),key(a.deployment),key(a.mint),Buffer.from([0]),u64(a.round),u32(a.index),key(a.wallet),...[a.maximum,a.payable,a.cost,a.value,a.holding,a.through,a.issued,a.expires,a.version,a.epoch].map(u64),Buffer.from([a.outcome]),bytes32(a.evidence)]);}
function attest(verifier,message,signature){return Ed25519Program.createInstructionWithPublicKey({publicKey:key(verifier),message,signature:Buffer.from(signature)});}
function initialize(program,admin,roles,policy){const d=pda(program,'deployment-v2'),loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');return ix(program,0,[meta(admin,true,true),meta(d,true),meta(program),meta(pda(loader,key(program))),meta(SystemProgram.programId)],...['publisher','verifier','guardian','operations'].map(k=>key(roles[k])),bytes32(policy));}
function prepare(program,payer,mint){const a=addresses(program,mint);return ix(program,1,[meta(payer,true,true),meta(a.deployment),meta(a.coin,true),meta(a.intake,true),meta(mint,false,true),meta(SystemProgram.programId)]);}
function sharing(program,mint,officialInstruction,locking){const a=addresses(program,mint);return ix(program,locking?3:2,[meta(a.deployment),meta(a.coin,true),meta(a.intake,true),...officialInstruction.keys.map(k=>({...k,isSigner:false}))]);}
function activate(program,mint,curve,config){const a=addresses(program,mint);return ix(program,4,[meta(a.deployment),meta(a.coin,true),meta(a.intake),meta(mint),meta(curve),meta(config)]);}
function credit(program,payer,a){const d=addresses(program,a.mint,0n,undefined,0,receiptEvent(a));return ix(program,5,[meta(payer,true,true),meta(d.deployment),meta(d.coin,true),meta(d.intake,true),meta(d.receipt,true),meta(SystemProgram.programId),meta(SYSVAR_INSTRUCTIONS_PUBKEY)],receiptMessage(a));}
function fund(program,payer,publisher,verifier,c,root,cutoff,manifest){const a=addresses(program,c.mint,c.round);return ix(program,6,[meta(payer,true,true),meta(publisher,false,true),meta(verifier,false,true),meta(a.deployment),meta(a.coin,true),meta(a.round,true),meta(SystemProgram.programId)],u64(c.round),bytes32(root.hash),u64(root.sum),u64(cutoff.slot),u64(cutoff.time),bytes32(manifest));}
function register(program,payer,c,award){const a=addresses(program,c.mint,c.round,award.wallet,award.index);return ix(program,7,[meta(payer,true,true),meta(a.deployment),meta(a.coin,true),meta(a.round,true),meta(a.position,true),meta(a.allocation,true),meta(award.wallet),meta(SystemProgram.programId)],u32(award.index),u64(award.amount),u32(award.proof.length),...award.proof.flatMap(n=>[bytes32(n.hash),u64(n.sum)]));}
function settle(program,a,tokenAccounts=[]){const d=addresses(program,a.mint,a.round,a.wallet,a.index);return ix(program,8,[meta(d.deployment),meta(d.coin,true),meta(d.round,true),meta(d.position,true),meta(d.allocation,true),meta(a.wallet,true),meta(SYSVAR_INSTRUCTIONS_PUBKEY),...tokenAccounts.map(x=>meta(x))],paymentMessage(a));}
function operations(program,mint,recipient){const a=addresses(program,mint);return ix(program,9,[meta(a.deployment),meta(a.coin,true),meta(recipient,true)]);}
function recordExit(program,payer,a){const d=addresses(program,a.mint,0n,a.wallet);return ix(program,10,[meta(payer,true,true),meta(d.deployment),meta(d.coin),meta(d.position,true),meta(SystemProgram.programId),meta(SYSVAR_INSTRUCTIONS_PUBKEY)],paymentMessage({...a,domain:'RBD2EXIT'}));}
function control(program,authority,tag){if(![11,12,13].includes(tag))throw Error('Invalid control');return ix(program,tag,[meta(authority,false,true),meta(pda(program,'deployment-v2'),true)]);}
function decode(data,type){
 const layouts={
 deployment:[256,'RBD2DEP0','admin:k publisher:k verifier:k guardian:k operations:k policy:h paused:b resumeAt:u'],
 coin:[320,'RBD2COIN','mint:k launcher:k deployment:k operations:k policy:h active:b receipts:u unallocated:u reserved:u paid:u operationsPayable:u operationsPaid:u splitRemainder:b lastRound:u lastOperationsCycle:u activationSlot:u fundingEpoch:u pendingRegistrations:u'],
 round:[256,'RBD2ROND','coin:k id:u root:h total:u remaining:u registered:u cutoffSlot:u cutoffTime:u manifest:h verifier:k policy:h'],
 position:[160,'RBD2POS0','coin:k wallet:k version:u paid:u active:u disqualified:b firstExit:h'],
 allocation:[160,'RBD2AWRD','round:k wallet:k index:i maximum:u paid:u released:u settled:b'],
 receipt:[128,'RBD2RCPT','coin:k event:h amount:u sourceSlot:u']};
 const spec=layouts[type];if(!spec)throw Error('Unknown account');const b=Buffer.from(data);if(b.length!==spec[0]||b.subarray(0,8).toString()!==spec[1])throw Error('Invalid account layout');
 let p=8;const r={};for(const field of spec[2].split(' ')){const[n,t]=field.split(':');const size={k:32,h:32,u:8,i:4,b:1}[t];const v=b.subarray(p,p+size);r[n]=t==='k'?new PublicKey(v).toBase58():t==='h'?v.toString('hex'):t==='u'?v.readBigUInt64LE():t==='i'?v.readUInt32LE():v[0];p+=size;}if(b.subarray(p).some(x=>x!==0))throw Error('Invalid account padding');return r;
}
module.exports={pk,key,u64,u32,hash,bytes32,pda,addresses,meta,ix,leaf,parent,tree,verifyProof,receiptMessage,receiptEvent,paymentMessage,attest,initialize,prepare,sharing,activate,credit,fund,register,settle,operations,recordExit,control,decode};
