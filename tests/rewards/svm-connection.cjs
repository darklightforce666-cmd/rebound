'use strict';
// A @solana/web3.js Connection-compatible adapter over LiteSVM running the COMPILED V3 program.
// Supports the subset the backend uses, plus fault injection:
//   faults.dropResponse  — transaction lands but the RPC answer is lost (ambiguous broadcast)
//   faults.rejectSend    — RPC refuses before submission (definitely not landed)
//   finalityLag          — landed transactions become "finalized" only after advance()
const fs=require('node:fs'),path=require('node:path');
const {LiteSVM,TransactionMetadata}=require('litesvm');const kit=require('@solana/kit');
const {PublicKey,Keypair,Transaction,VersionedTransaction}=require('@solana/web3.js'),bs58=require('bs58');
const SO=path.join(__dirname,'../../contracts/v3/target/deploy/rebound_rewards_v3.so');
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const A=x=>kit.address(typeof x==='string'?x:x.toBase58());

class SvmConnection{
 constructor({program=Keypair.generate().publicKey,admin}={}){
  // The V3 program is loaded when built (program tests are skipped without it); plain SOL transfers — direct
  // settlement — need no program, so those tests also run on CI where contracts/v3 is not compiled.
  if(admin&&!fs.existsSync(SO))throw Error('Build contracts/v3 first (cargo build-sbf)');
  this.svm=new LiteSVM();this.program=program;if(fs.existsSync(SO))this.svm.addProgramFromFile(A(program),SO);
  this.faults={dropResponse:0,rejectSend:0};this.statuses=new Map();this.parsed=new Map();this.height=100;this.sent=0;this.landed=[];
  if(admin){ // upgradeable-loader authority fixture checked by Initialize
   const programData=PublicKey.findProgramAddressSync([program.toBuffer()],LOADER)[0];this.programData=programData;
   const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
   this.svm.setAccount({address:A(program),lamports:1_000_000n,programAddress:A(LOADER),executable:true,data:Buffer.concat([u32(2),programData.toBuffer()]),space:36n});
   const pd=Buffer.concat([u32(3),Buffer.alloc(8),Buffer.from([1]),admin.toBuffer()]);
   this.svm.setAccount({address:A(programData),lamports:10_000_000n,programAddress:A(LOADER),executable:false,data:pd,space:BigInt(pd.length)});
  }
 }
 airdrop(pk,lamports){this.svm.airdrop(A(pk),BigInt(lamports));}
 setTime(t,slot){const c=this.svm.getClock();c.unixTimestamp=BigInt(t);if(slot!=null)c.slot=BigInt(slot);this.svm.setClock(c);}
 advance({seconds=0,slots=1,blocks=1}={}){const c=this.svm.getClock();c.unixTimestamp+=BigInt(seconds);c.slot+=BigInt(slots);this.svm.setClock(c);this.height+=blocks;}
 async getLatestBlockhash(){this.svm.expireBlockhash();return{blockhash:this.svm.latestBlockhash(),lastValidBlockHeight:this.height+150};}
 async getBlockHeight(){return this.height;}
 async getSlot(){return Number(this.svm.getClock().slot);}
 async getBlockTime(){return Number(this.svm.getClock().unixTimestamp);}
 async getMinimumBalanceForRentExemption(n){return Number(this.svm.minimumBalanceForRentExemption(BigInt(n)));}
 _info(pk){const a=this.svm.getAccount(A(pk));if(!a||!a.exists)return null;return{lamports:Number(a.lamports),owner:new PublicKey(a.programAddress),executable:a.executable,data:Buffer.from(a.data),rentEpoch:0};}
 async getAccountInfo(pk){return this._info(pk);}
 async getAccountInfoAndContext(pk){return{context:{slot:await this.getSlot()},value:this._info(pk)};}
 async getMultipleAccountsInfo(pks){return pks.map(p=>this._info(p));}
 async getMultipleAccountsInfoAndContext(pks){return{context:{slot:await this.getSlot()},value:pks.map(p=>this._info(p))};}
 async getTokenAccountBalance(pk){const i=this._info(pk);if(!i)throw Error('account not found');return{context:{slot:await this.getSlot()},value:{amount:i.data.readBigUInt64LE(64).toString()}};}
 // Cloned mainnet programs/accounts (contracts/v3/fixtures/mainnet, read-only capture).
 loadProtocol(dir){const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  for(const p of m.programs)this.svm.addProgramFromFile(A(p.id),path.join(dir,p.file));
  for(const a of m.accounts)if(!a.missing)this.svm.setAccount({address:A(a.id),lamports:BigInt(a.lamports),programAddress:A(a.owner),executable:a.executable,data:Buffer.from(a.data,'base64'),space:BigInt(Buffer.from(a.data,'base64').length)});
  return m;}
 async getBalance(pk){return Number(this.svm.getBalance(A(pk))||0n);}
 async getBalanceAndContext(pk){return{context:{slot:await this.getSlot()},value:await this.getBalance(pk)};}
 async simulateTransaction(tx,signers){
  if(tx instanceof VersionedTransaction){   // web3.js v1 form: (versionedTx, {sigVerify:false, accounts:{addresses,encoding:'base64'}})
   const opts=signers&&!Array.isArray(signers)?signers:{};
   if(opts.replaceRecentBlockhash!==false&&!opts.accounts){const {blockhash}=await this.getLatestBlockhash();tx.message.recentBlockhash=blockhash;}
   this.svm.withSigverify(false);try{const r=this.svm.simulateTransaction(kit.getTransactionDecoder().decode(tx.serialize()));const failed=typeof r.err==='function';
    // Requested accounts after the simulated transaction (unchanged ones as they are now).
    let accounts;if(!failed&&opts.accounts){const post=new Map((r.postAccounts?.()||[]).map(a=>[String(a.address),a]));
     accounts=opts.accounts.addresses.map(k=>{const a=post.get(String(k));if(a)return{lamports:Number(a.lamports),data:[Buffer.from(a.data).toString('base64'),'base64']};const i=this._info(k);return i?{lamports:i.lamports,data:[Buffer.from(i.data).toString('base64'),'base64']}:null;});}
    return{value:{err:failed?String(r.err()):null,logs:failed?r.meta().logs():r.meta?.().logs?.()||[],...(accounts?{accounts}:{})}};}finally{this.svm.withSigverify(true);}}
  if(signers)tx.sign(...signers);const r=this.svm.simulateTransaction(kit.getTransactionDecoder().decode(tx.serialize({requireAllSignatures:false,verifySignatures:false})));
  const failed=typeof r.err==='function';return{value:{err:failed?String(r.err()):null,logs:failed?r.meta().logs():r.meta?.().logs?.()||[]}};}
 async sendRawTransaction(bytes){
  this.sent++;if(this.faults.rejectSend>0){this.faults.rejectSend--;throw Error('fixture: RPC rejected before submission');}
  const decoded=kit.getTransactionDecoder().decode(Uint8Array.from(bytes));const sig=bs58.encode(Buffer.from(bytes).subarray(1,65));
  if(!this.statuses.has(sig)){
   const legacy=(()=>{try{return Transaction.from(Buffer.from(bytes));}catch{return null;}})(),msg=legacy?.compileMessage(),keys=msg?msg.accountKeys.map(k=>k.toBase58()):[];
   const pre=keys.map(k=>Number(this.svm.getBalance(A(k))||0n));
   const r=this.svm.sendTransaction(decoded);const ok=r instanceof TransactionMetadata;
   this.statuses.set(sig,{slot:await this.getSlot(),err:ok?null:String(r.err()),confirmationStatus:'confirmed',logs:ok?r.logs():r.meta().logs()});
   if(ok){this.landed.push(sig);if(msg)this.parsed.set(sig,this._parsed(sig,msg,keys,pre,r));}}
  if(this.faults.dropResponse>0){this.faults.dropResponse--;throw Error('fixture: RPC response lost after submission');}
  const s=this.statuses.get(sig);if(s.err)throw Error('Transaction simulation failed: '+s.err);return sig;
 }
 // jsonParsed-shaped finalized transaction (system transfers parsed; everything else raw), for receipt tests.
 _parsed(sig,msg,keys,pre,meta){
  const SYS='11111111111111111111111111111111';const signers=msg.header.numRequiredSignatures;
  const one=(programIdIndex,accounts,data)=>{const programId=keys[programIdIndex],acc=Array.from(accounts).map(i=>keys[i]),d=Buffer.from(data);
   if(programId===SYS&&d.length>=12&&d.readUInt32LE(0)===2)return{programId,parsed:{type:'transfer',info:{source:acc[0],destination:acc[1],lamports:Number(d.readBigUInt64LE(4))}}};
   return{programId,accounts:acc,data:bs58.encode(d)};};
  const inner=meta.innerInstructions().map((list,index)=>({index,instructions:list.map(x=>({...one(x.instruction().programIdIndex(),x.instruction().accounts(),x.instruction().data()),stackHeight:x.stackHeight()}))})).filter(x=>x.instructions.length);
  return{slot:Number(this.svm.getClock().slot),blockTime:Number(this.svm.getClock().unixTimestamp),transaction:{signatures:[sig],message:{accountKeys:keys.map((k,i)=>({pubkey:k,signer:i<signers,writable:msg.isAccountWritable(i)})),instructions:msg.instructions.map(i=>one(i.programIdIndex,i.accounts,bs58.decode(i.data)))}},
   meta:{err:null,fee:5000*signers,preBalances:pre,postBalances:keys.map(k=>Number(this.svm.getBalance(A(k))||0n)),innerInstructions:inner,preTokenBalances:[],postTokenBalances:[],logMessages:meta.logs()}};
 }
 async getSignaturesForAddress(key,o={}){return this.rpc().call('getSignaturesForAddress',[key.toBase58(),o]);}
 async getTransaction(sig){return this.parsed.get(sig)||null;}
 async getParsedTransaction(sig){return this.parsed.get(sig)||null;}
 // Minimal JSON-RPC facade (history-v3 Rpc interface) over the landed transactions.
 rpc(){const self=this;return{calls:0,async call(m,p){this.calls++;
  if(m==='getSlot')return self.getSlot();if(m==='getBlockTime')return self.getBlockTime();
  if(m==='getTransaction')return self.parsed.get(p[0])||null;
  if(m==='getSignaturesForAddress'){const [addr,o={}]=p;let list=self.landed.filter(s=>self.parsed.get(s)?.transaction.message.accountKeys.some(k=>k.pubkey===addr)).reverse().map(s=>({signature:s,slot:self.parsed.get(s).slot,err:null,blockTime:self.parsed.get(s).blockTime}));
   if(o.until){const i=list.findIndex(x=>x.signature===o.until);if(i>=0)list=list.slice(0,i);}if(o.before){const i=list.findIndex(x=>x.signature===o.before);list=list.slice(i+1);}return list.slice(0,o.limit||1000);}
  throw Error('svm rpc: unsupported '+m);}};}
 finalizeAll(){for(const s of this.statuses.values())s.confirmationStatus='finalized';}
 async getSignatureStatuses(sigs){return{value:sigs.map(s=>{const x=this.statuses.get(s);return x?{slot:x.slot,err:x.err,confirmationStatus:x.confirmationStatus}:null;})};}
 logsOf(sig){return this.statuses.get(sig)?.logs||[];}
}
module.exports={SvmConnection,A};
