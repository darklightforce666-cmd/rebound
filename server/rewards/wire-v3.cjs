'use strict';
// Exact Borsh wire format for contracts/v3 (program rebound-rewards-v3). Byte-for-byte parity with
// the Rust program is proven by contracts/v3/tests/test_wire_parity.py, which executes
// instructions produced by this module against the compiled SBF binary.
const crypto=require('node:crypto');
const {PublicKey,TransactionInstruction,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY,Ed25519Program}=require('@solana/web3.js');
const pk=x=>x instanceof PublicKey?x:new PublicKey(x);
const key=x=>pk(x).toBuffer();
const u64=x=>{const n=BigInt(x);if(n<0n||n>0xffffffffffffffffn)throw Error('u64 overflow');const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
const i64=x=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(x));return b;};
const u32=x=>{const n=Number(x);if(!Number.isInteger(n)||n<0||n>0xffffffff)throw Error('u32 overflow');const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u16=x=>{const n=Number(x);if(!Number.isInteger(n)||n<0||n>0xffff)throw Error('u16 overflow');const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const bool=x=>Buffer.from([x?1:0]);
const hash=(...x)=>crypto.createHash('sha256').update(Buffer.concat(x.map(v=>typeof v==='string'?Buffer.from(v):v))).digest();
const bytes32=x=>{const b=Buffer.isBuffer(x)?x:Buffer.from(x,'hex');if(b.length!==32)throw Error('Expected 32 bytes');return b;};
const pda=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),pk(program))[0];
const SYSTEM=SystemProgram.programId,LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const TAG=Object.freeze({Initialize:0,RegisterPrimary:1,StartPrimary:2,SetFundingWallet:3,DepositHolders:4,PrepareCoin:5,CreateSharing:6,LockSharing:7,Activate:8,Credit:9,Fund:10,Pay:11,Pause:12,RequestResume:13,Resume:14,SetAuthorities:15,SetBuybackTarget:16,ReserveBuyback:17,BuybackSwap:18,BuybackBurn:19,CloseBuyback:20});
const ERRORS=Object.freeze(Object.fromEntries('Unauthorized Account Data Arithmetic Funds Paused Round Proof Settled Stale Kind Inactive TooSoon TooLate Routing Buyback Burn'.split(' ').map((n,i)=>[300+i,n])));

function addresses(program,mint,{cycle,index,job,event}={}){
 const deployment=pda(program,'deployment-v3'),coin=mint?pda(program,'coin-v3',key(mint)):undefined;
 const out={deployment,coin,intake:mint?pda(program,'intake-v3',key(mint)):undefined};
 if(coin&&cycle!=null){out.round=pda(program,'round-v3',key(coin),u64(cycle));if(index!=null)out.paid=pda(program,'paid-v3',key(out.round),u32(index));}
 if(coin&&job!=null){out.job=pda(program,'buyback-v3',key(coin),u64(job));out.buyer=pda(program,'buyer-v3',key(out.job));}
 if(coin&&event)out.receipt=pda(program,'receipt-v3',key(coin),bytes32(event));
 return out;
}
const meta=(k,w=false,s=false)=>({pubkey:pk(k),isWritable:w,isSigner:s});
const ix=(program,tag,keys,...data)=>new TransactionInstruction({programId:pk(program),keys,data:Buffer.concat([Buffer.from([tag]),...data])});

// ---- Merkle-sum manifest (sorted pairs, odd node promoted unchanged) ----
function leaf(c,a){return{hash:hash('REBOUND:leaf:v3',key(c.program),key(c.deployment),key(c.mint),bytes32(c.policy),u64(c.cycle),u32(a.index),key(a.wallet),u64(a.amount)),sum:BigInt(a.amount)};}
function parent(a,b){
 const cmp=Buffer.compare(a.hash,b.hash);if(cmp>0||(cmp===0&&a.sum>b.sum))[a,b]=[b,a];
 return{hash:hash('REBOUND:node:v3',a.hash,u64(a.sum),b.hash,u64(b.sum)),sum:a.sum+b.sum};
}
function tree(c,awards){
 if(!awards.length||awards.length>1_000_000)throw Error('Invalid manifest size');
 const seen=new Set();awards.forEach((a,i)=>{if(a.index!==i)throw Error('Award indexes must be 0..n-1 in order');if(BigInt(a.amount)<=0n)throw Error('Empty award');if(seen.has(pk(a.wallet).toBase58()))throw Error('Duplicate recipient');seen.add(pk(a.wallet).toBase58());});
 const levels=[awards.map(a=>leaf(c,a))];
 while(levels.at(-1).length>1){const l=levels.at(-1),n=[];for(let i=0;i<l.length;i+=2)n.push(l[i+1]?parent(l[i],l[i+1]):l[i]);levels.push(n);}
 return{root:levels.at(-1)[0],awards:awards.map((a,i)=>{const proof=[];let j=i;for(let k=0;k<levels.length-1;k++){const s=levels[k][j^1];if(s)proof.push(s);j=Math.floor(j/2);}return{...a,proof};})};
}
function verify(c,a,root){let n=leaf(c,a);for(const s of a.proof)n=parent(n,{hash:bytes32(s.hash),sum:BigInt(s.sum)});return n.hash.equals(bytes32(root.hash))&&n.sum===BigInt(root.sum);}
const nodeBytes=n=>Buffer.concat([bytes32(n.hash),u64(n.sum)]);
const nodes=list=>Buffer.concat([u32(list.length),...list.map(nodeBytes)]);

// ---- instructions ----
const I={
 initialize:(program,{admin,programData,publisher,verifier,guardian,policy,testMode})=>ix(program,TAG.Initialize,[meta(admin,true,true),meta(addresses(program).deployment,true),meta(program),meta(programData||pda(LOADER,key(program))),meta(SYSTEM)],key(publisher),key(verifier),key(guardian),bytes32(policy),bool(testMode)),
 registerPrimary:(program,{admin,mint,fundingWallet})=>{const a=addresses(program,mint);return ix(program,TAG.RegisterPrimary,[meta(admin,true,true),meta(a.deployment),meta(a.coin,true),meta(mint),meta(SYSTEM)],key(fundingWallet));},
 startPrimary:(program,{admin,mint})=>{const a=addresses(program,mint);return ix(program,TAG.StartPrimary,[meta(admin,true,true),meta(a.deployment),meta(a.coin,true)]);},
 setFundingWallet:(program,{admin,mint,fundingWallet})=>{const a=addresses(program,mint);return ix(program,TAG.SetFundingWallet,[meta(admin,true,true),meta(a.deployment),meta(a.coin,true)],key(fundingWallet));},
 // Holder-only primary deposit. The DEV WALLET signs (manual: in the browser; automatic: server signer).
 depositHolders:(program,{fundingWallet,mint,amount})=>{const a=addresses(program,mint);return ix(program,TAG.DepositHolders,[meta(fundingWallet,true,true),meta(a.deployment),meta(a.coin,true),meta(SYSTEM)],u64(amount));},
 prepareCoin:(program,{payer,mint})=>{const a=addresses(program,mint);return ix(program,TAG.PrepareCoin,[meta(payer,true,true),meta(a.deployment),meta(a.coin,true),meta(a.intake,true),meta(mint,false,true),meta(SYSTEM)]);},
 // Pump fee-sharing setup, signed by the intake PDA inside the program. `official` = the SDK's
 // createFeeSharingConfig (13 keys) / updateFeeSharesV2 (20 keys) instruction, forwarded verbatim.
 createSharing:(program,{mint,official})=>{const a=addresses(program,mint);return ix(program,TAG.CreateSharing,[meta(a.deployment),meta(a.coin,true),meta(a.intake,true),...official.keys.map(k=>({...k,isSigner:false}))]);},
 lockSharing:(program,{mint,official})=>{const a=addresses(program,mint);return ix(program,TAG.LockSharing,[meta(a.deployment),meta(a.coin,true),meta(a.intake,true),...official.keys.map(k=>({...k,isSigner:false}))]);},
 activate:(program,{mint,curve,sharingConfig})=>{const a=addresses(program,mint);return ix(program,TAG.Activate,[meta(a.deployment),meta(a.coin,true),meta(a.intake),meta(mint),meta(curve),meta(sharingConfig)]);},
 fund:(program,{payer,publisher,verifier,mint,cycle,root,count,cutoffSlot,snapshot,manifest})=>{const a=addresses(program,mint,{cycle});return ix(program,TAG.Fund,[meta(payer,true,true),meta(publisher,false,true),meta(verifier,false,true),meta(a.deployment),meta(a.coin,true),meta(a.round,true),meta(SYSTEM)],u64(cycle),nodeBytes(root),u32(count),u64(cutoffSlot),bytes32(snapshot),bytes32(manifest));},
 pay:(program,{payer,mint,cycle,index,wallet,amount,proof})=>{const a=addresses(program,mint,{cycle,index});return ix(program,TAG.Pay,[meta(payer,true,true),meta(a.deployment),meta(a.coin,true),meta(a.round,true),meta(a.paid,true),meta(wallet,true),meta(SYSTEM)],u64(cycle),u32(index),u64(amount),nodes(proof));},
 pause:(program,{authority})=>ix(program,TAG.Pause,[meta(authority,false,true),meta(addresses(program).deployment,true)]),
 requestResume:(program,{admin})=>ix(program,TAG.RequestResume,[meta(admin,false,true),meta(addresses(program).deployment,true)]),
 resume:(program,{admin})=>ix(program,TAG.Resume,[meta(admin,false,true),meta(addresses(program).deployment,true)]),
 setAuthorities:(program,{admin,publisher,verifier,guardian})=>ix(program,TAG.SetAuthorities,[meta(admin,false,true),meta(addresses(program).deployment,true)],key(publisher),key(verifier),key(guardian)),
 setBuybackTarget:(program,{admin,targetMint})=>ix(program,TAG.SetBuybackTarget,[meta(admin,true,true),meta(addresses(program).deployment,true),meta(targetMint)],key(targetMint)),
 reserveBuyback:(program,{payer,publisher,mint,job,cycle,amount,maxSlippageBps,maxImpactBps})=>{const a=addresses(program,mint,{job});return ix(program,TAG.ReserveBuyback,[meta(payer,true,true),meta(publisher,false,true),meta(a.deployment),meta(a.coin,true),meta(a.job,true),meta(a.buyer,true),meta(SYSTEM)],u64(cycle),u64(amount),u16(maxSlippageBps),u16(maxImpactBps));},
 // `market` = the forwarded Pump (16) or PumpSwap (23) account metas, produced by the official SDK.
 buybackSwap:(program,{publisher,mint,job,minOut,market})=>{const a=addresses(program,mint,{job});return ix(program,TAG.BuybackSwap,[meta(publisher,false,true),meta(a.deployment),meta(a.coin),meta(a.job,true),meta(a.buyer,true),...market.map(m=>({...m,isSigner:false}))],u64(minOut));},
 buybackBurn:(program,{mint,job,holding,targetMint,tokenProgram})=>{const a=addresses(program,mint,{job});return ix(program,TAG.BuybackBurn,[meta(a.deployment),meta(a.coin),meta(a.job,true),meta(a.buyer),meta(holding,true),meta(targetMint,true),meta(tokenProgram)]);},
 closeBuyback:(program,{payer,mint,job})=>{const a=addresses(program,mint,{job});return ix(program,TAG.CloseBuyback,[meta(payer,true,true),meta(a.deployment),meta(a.coin,true),meta(a.job,true),meta(a.buyer,true),meta(SYSTEM)]);},
};

// ---- third-party receipt attestation (verifier Ed25519, preceding instruction) ----
function receiptMessage(program,deployment,{mint,signature,instructionPath,amount,through,issued,expires}){
 const sig=Buffer.from(signature);if(sig.length!==64)throw Error('Receipt signature length');
 return Buffer.concat([Buffer.from('RBD3RCPT'),key(program),key(deployment),key(mint),Buffer.from([0]),sig,bytes32(instructionPath),u64(amount),u64(through),u64(issued),u64(expires)]);
}
const receiptEvent=({signature,instructionPath,mint})=>hash('REBOUND:receipt:v3',Buffer.from(signature),bytes32(instructionPath),key(mint));
function credit(program,{payer,mint,message,verifierSignature,verifier,event}){
 const a=addresses(program,mint,{event});
 return[Ed25519Program.createInstructionWithPublicKey({publicKey:key(verifier),message,signature:verifierSignature}),ix(program,TAG.Credit,[meta(payer,true,true),meta(a.deployment),meta(a.coin,true),meta(a.intake,true),meta(a.receipt,true),meta(SYSTEM),meta(SYSVAR_INSTRUCTIONS_PUBKEY)],message)];
}

// ---- account decoders ----
const rd=(b,o,n)=>b.subarray(o,o+n);
function decode(kind,data){
 const b=Buffer.from(data);let o=8;const p=()=>{const v=new PublicKey(rd(b,o,32)).toBase58();o+=32;return v;},q=()=>{const v=b.readBigUInt64LE(o);o+=8;return v;},s=()=>{const v=b.readBigInt64LE(o);o+=8;return v;},h32=()=>{const v=rd(b,o,32).toString('hex');o+=32;return v;},by=()=>b[o++],u4=()=>{const v=b.readUInt32LE(o);o+=4;return v;},w=()=>{const v=b.readUInt16LE(o);o+=2;return v;};
 const magic=rd(b,0,8).toString();
 if(kind==='deployment'){if(magic!=='RBD3DEP0')throw Error('Not a V3 deployment');return{admin:p(),publisher:p(),verifier:p(),guardian:p(),policy:h32(),testMode:!!by(),paused:!!by(),resumeAt:s(),targetMint:p(),targetTokenProgram:p(),configVersion:q()};}
 if(kind==='coin'){if(magic!=='RBD3COIN')throw Error('Not a V3 coin');return{mint:p(),kind:by()===0?'primary':'third_party',deployment:p(),policy:h32(),active:!!by(),anchor:s(),cycleSeconds:s(),cutoffLead:s(),fundingWallet:p(),launcher:p(),receipts:q(),deposits:q(),holderUnallocated:q(),holderReserved:q(),holderPaid:q(),buybackAvailable:q(),buybackReserved:q(),buybackSpent:q(),splitCarry:by(),lastCycle:q(),nextJob:q()};}
 if(kind==='round'){if(magic!=='RBD3ROND')throw Error('Not a V3 round');return{coin:p(),cycle:q(),root:h32(),total:q(),remaining:q(),count:u4(),paidCount:u4(),cutoffSlot:q(),cutoffTime:s(),dueTime:s(),snapshot:h32(),manifest:h32(),policy:h32(),verifier:p()};}
 if(kind==='paid'){if(magic!=='RBD3PAID')throw Error('Not a V3 paid receipt');return{round:p(),index:u4(),wallet:p(),amount:q(),slot:q()};}
 if(kind==='job'){if(magic!=='RBD3JOB0')throw Error('Not a V3 job');return{coin:p(),id:q(),cycle:q(),targetMint:p(),targetTokenProgram:p(),configVersion:q(),budget:q(),state:['reserved','purchased','burned','closed'][by()],spent:q(),acquired:q(),burned:q(),maxSlippageBps:w(),maxImpactBps:w(),purchaseSlot:q(),burnSlot:q()};}
 throw Error('Unknown account kind');
}
function errorName(err){const m=/"Custom":(\d+)|Custom\((\d+)\)/.exec(typeof err==='string'?err:JSON.stringify(err||{}));const code=m&&Number(m[1]||m[2]);return code&&ERRORS[code]||null;}
module.exports={TAG,ERRORS,pk,key,u64,i64,u32,u16,hash,bytes32,pda,addresses,leaf,parent,tree,verify,nodes,I,receiptMessage,receiptEvent,credit,decode,errorName};
