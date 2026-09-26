'use strict';
// A @solana/web3.js Connection-compatible adapter over LiteSVM running the COMPILED V3 program.
// Supports the subset the backend uses, plus fault injection:
//   faults.dropResponse  — transaction lands but the RPC answer is lost (ambiguous broadcast)
//   faults.rejectSend    — RPC refuses before submission (definitely not landed)
//   finalityLag          — landed transactions become "finalized" only after advance()
const fs=require('node:fs'),path=require('node:path');
const {LiteSVM,TransactionMetadata}=require('litesvm');const kit=require('@solana/kit');
const {PublicKey,Keypair}=require('@solana/web3.js'),bs58=require('bs58');
const SO=path.join(__dirname,'../../contracts/v3/target/deploy/rebound_rewards_v3.so');
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const A=x=>kit.address(typeof x==='string'?x:x.toBase58());

class SvmConnection{
 constructor({program=Keypair.generate().publicKey,admin}={}){
  if(!fs.existsSync(SO))throw Error('Build contracts/v3 first (cargo build-sbf)');
  this.svm=new LiteSVM();this.program=program;this.svm.addProgramFromFile(A(program),SO);
  this.faults={dropResponse:0,rejectSend:0};this.statuses=new Map();this.height=100;this.sent=0;this.landed=[];
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
 async simulateTransaction(tx,signers){if(signers)tx.sign(...signers);const r=this.svm.simulateTransaction(kit.getTransactionDecoder().decode(tx.serialize({requireAllSignatures:false,verifySignatures:false})));
  const failed=typeof r.err==='function';return{value:{err:failed?String(r.err()):null,logs:failed?r.meta().logs():r.meta?.().logs?.()||[]}};}
 async sendRawTransaction(bytes){
  this.sent++;if(this.faults.rejectSend>0){this.faults.rejectSend--;throw Error('fixture: RPC rejected before submission');}
  const decoded=kit.getTransactionDecoder().decode(Uint8Array.from(bytes));const sig=bs58.encode(Buffer.from(bytes).subarray(1,65));
  if(!this.statuses.has(sig)){const r=this.svm.sendTransaction(decoded);const ok=r instanceof TransactionMetadata;
   this.statuses.set(sig,{slot:await this.getSlot(),err:ok?null:String(r.err()),confirmationStatus:'confirmed',logs:ok?r.logs():r.meta().logs()});if(ok)this.landed.push(sig);}
  if(this.faults.dropResponse>0){this.faults.dropResponse--;throw Error('fixture: RPC response lost after submission');}
  const s=this.statuses.get(sig);if(s.err)throw Error('Transaction simulation failed: '+s.err);return sig;
 }
 finalizeAll(){for(const s of this.statuses.values())s.confirmationStatus='finalized';}
 async getSignatureStatuses(sigs){return{value:sigs.map(s=>{const x=this.statuses.get(s);return x?{slot:x.slot,err:x.err,confirmationStatus:x.confirmationStatus}:null;})};}
 logsOf(sig){return this.statuses.get(sig)?.logs||[];}
}
module.exports={SvmConnection,A};
