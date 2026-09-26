'use strict';
// Worker side of the key inbox (migration 013). The scheduler host keeps a private X25519 inbox key
// in REWARDS_INBOX_KEY_FILE (created on first start, mode 600) and publishes only its public half in
// reward_worker_keys. A pending inbox row is opened here, checked to be exactly the registered fee
// wallet's secret key, re-encrypted under the signer master key (reward_signers, signer.cjs) and the
// funding wallet switches to automatic deposits. The inbox row is wiped whatever the outcome.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Keypair}=require('@solana/web3.js'),bs58=require('bs58');
const Seal=require('./inbox-seal.cjs'),Signer=require('./signer.cjs'),Logs=require('./logs.cjs'),DB=require('./db.cjs');
// web3.js' Keypair.secretKey getter returns a copy; wipe the internal buffer (best effort).
const wipeKeypair=kp=>{try{kp?._keypair?.secretKey?.fill(0);}catch{}};

function writeSecret(file,content){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,content,{mode:0o600,flag:'wx'});fs.chmodSync(file,0o600);}
/** Load (or create once) the inbox key. Returns the private JWK, or null when not configured. */
async function inboxKey(env=process.env){
 if(env.REWARDS_INBOX_KEY){const j=JSON.parse(env.REWARDS_INBOX_KEY);if(j.kty!=='OKP'||j.crv!=='X25519'||!j.d||!j.x)throw Object.assign(Error('REWARDS_INBOX_KEY is not an X25519 JWK'),{code:'INBOX_INVALID'});return j;}   // hosted worker
 const file=env.REWARDS_INBOX_KEY_FILE;if(!file)return null;
 if(!fs.existsSync(file))writeSecret(file,JSON.stringify(await Seal.generate()));
 if((fs.statSync(file).mode&0o077)!==0)throw Object.assign(Error('Inbox key file must not be readable by group/other (chmod 600)'),{code:'INBOX_INSECURE'});
 const j=JSON.parse(fs.readFileSync(file,'utf8'));if(j.kty!=='OKP'||j.crv!=='X25519'||!j.d||!j.x)throw Object.assign(Error('Inbox key file is not an X25519 JWK'),{code:'INBOX_INVALID'});
 return j;
}
/** Create the signer master key only on a host that has never encrypted a signer; a missing file with
 *  existing signers means the secrets volume is missing — never silently replace the key then. */
async function ensureMasterKey(db,env=process.env){
 if(env.REWARDS_SIGNER_MASTER_KEY)return{ok:true};
 const f=env.REWARDS_SIGNER_MASTER_KEY_FILE;if(!f)return{ok:false,reason:'REWARDS_SIGNER_MASTER_KEY_FILE is not set on the worker'};
 if(fs.existsSync(f))return{ok:true};
 const n=(await db.query("SELECT count(*)::int n FROM reward_signers WHERE storage='encrypted_local' AND status<>'revoked'")).rows[0].n;
 if(n>0)return{ok:false,reason:'the worker cannot find its signer master key file (existing imported keys depend on it)'};
 writeSecret(f,crypto.randomBytes(32).toString('hex'));return{ok:true};
}

async function publish(db,jwk,worker){
 await db.query(`INSERT INTO reward_worker_keys(id,inbox_public_key,worker,updated_at) VALUES(1,$1,$2,now())
  ON CONFLICT(id) DO UPDATE SET inbox_public_key=EXCLUDED.inbox_public_key,worker=EXCLUDED.worker,updated_at=now() WHERE reward_worker_keys.inbox_public_key<>EXCLUDED.inbox_public_key`,[jwk.x,worker||null]);
}
const WIPE="ephemeral_public_key=NULL,iv=NULL,ciphertext=NULL,processed_at=now()";
async function finish(db,id,state,reason){await db.query(`UPDATE reward_key_inbox SET state=$2,reason=$3,${WIPE} WHERE id=$1 AND state='pending'`,[id,state,reason||null]);}

/** Process pending inbox rows. Never logs or returns key material. */
async function processInbox(db,{env=process.env,worker='worker'}={}){
 const jwk=await inboxKey(env);if(!jwk)return{configured:false};
 await publish(db,jwk,worker);await ensureMasterKey(db,env);
 const rows=(await db.query("SELECT id FROM reward_key_inbox WHERE state='pending' LIMIT 1")).rows;if(!rows.length)return{configured:true,publicKey:jwk.x,processed:[]};
 return DB.withLease(db,'key-inbox',worker,()=>processPending(db,jwk,env),{seconds:60,busy:()=>({configured:true,publicKey:jwk.x,processed:[],busy:true})});
}
async function processPending(db,jwk,env){
 const master=await ensureMasterKey(db,env);
 const rows=(await db.query("SELECT * FROM reward_key_inbox WHERE state='pending' ORDER BY created_at")).rows;const out=[];
 for(const r of rows){
  let secret=null;
  try{
   const fw=(await db.query('SELECT * FROM reward_funding_wallets WHERE id=$1',[r.funding_wallet])).rows[0];
   if(!fw||fw.status==='retired')throw Object.assign(Error('This fee wallet is no longer registered; paste the key again for the current one'),{code:'WALLET_RETIRED'});
   if(fw.address!==r.address)throw Object.assign(Error('The key was sent for another wallet'),{code:'WALLET_MISMATCH'});
   if(!master.ok)throw Object.assign(Error('Not imported: '+master.reason),{code:'SIGNER_UNCONFIGURED'});
   if(r.inbox_public_key!==jwk.x)throw Object.assign(Error('The key was sealed to an older worker key; paste it again'),{code:'INBOX_KEY_CHANGED'});
   try{secret=await Seal.open({ephemeralPublicKey:r.ephemeral_public_key,iv:r.iv,ciphertext:r.ciphertext},jwk,{fundingWallet:r.funding_wallet,address:r.address});}
   catch{throw Object.assign(Error('The sealed key could not be opened by this worker'),{code:'INBOX_DECRYPT'});}
   if(secret.length!==64)throw Object.assign(Error('Not a 64-byte Solana secret key'),{code:'SIGNER_FORMAT'});
   let kp;try{kp=Keypair.fromSecretKey(Uint8Array.from(secret));}   // copy: fromSecretKey keeps a reference, which is wiped below
  catch{throw Object.assign(Error('Not a valid Solana secret key'),{code:'SIGNER_FORMAT'});}
   const addr=kp.publicKey.toBase58();wipeKeypair(kp);
   if(addr!==fw.address)throw Object.assign(Error('The key does not belong to the fee wallet '+fw.address),{code:'SIGNER_MISMATCH'});
   // Atomic swap: retire the previous signer, import the new one and point the wallet at it — all or nothing,
   // so a failed import never leaves the wallet on a revoked signer.
   await DB.transaction(db,async tx=>{
    for(const old of (await tx.query("SELECT id FROM reward_signers WHERE role='primary_dev' AND address=$1 AND status<>'revoked'",[addr])).rows)await Signer.revoke(tx,old.id);
    const imported=await Signer.importSigner(tx,{role:'primary_dev',secretText:bs58.encode(secret),expectedAddress:addr,env});
    await tx.query("UPDATE reward_funding_wallets SET mode='automatic',signer=$2 WHERE id=$1",[fw.id,imported.id]);
    await tx.query(`UPDATE reward_key_inbox SET state='imported',reason=NULL,${WIPE} WHERE id=$1 AND state='pending'`,[r.id]);
   },{serializable:false});
   await Logs.log(db,{severity:'warn',component:'scheduler',eventType:'fee_wallet_key_imported',mint:fw.mint,message:`Fee wallet ${addr} key imported on the worker (encrypted at rest); holder deposits are now automatic`});
   out.push({id:r.id,state:'imported',address:addr});
  }catch(e){
   await finish(db,r.id,'failed',e.message).catch(()=>{});
   await Logs.log(db,{severity:'warn',component:'scheduler',eventType:'fee_wallet_key_rejected',message:'Fee wallet key not imported: '+e.message,errorCode:e.code||'INBOX_FAILED'}).catch(()=>{});
   out.push({id:r.id,state:'failed',code:e.code||'INBOX_FAILED'});
  }finally{if(secret)secret.fill(0);}
 }
 return{configured:true,publicKey:jwk.x,processed:out};
}

/** API side: store a sealed key for the live fee wallet of `mint` (admin only; ciphertext only). */
async function submit(db,actor,{mint,address,inboxPublicKey,ephemeralPublicKey,iv,ciphertext}){
 const fail=(code,message,status=400)=>{throw Object.assign(Error(message),{code,status});};
 const b64=/^[A-Za-z0-9_-]+$/;
 for(const [v,n,min,max] of [[inboxPublicKey,'worker key',43,43],[ephemeralPublicKey,'ephemeral key',43,43],[iv,'iv',16,16],[ciphertext,'ciphertext',100,120]])
  if(typeof v!=='string'||!b64.test(v)||v.length<min||v.length>max)fail('INVALID_BODY','Invalid '+n);
 const fw=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[String(mint||'')])).rows[0];
 if(!fw)fail('NOT_FOUND','Launch the token with its fee wallet first',404);
 if(fw.address!==address)fail('WALLET_MISMATCH','This key is for another wallet than the registered fee wallet',409);
 const wk=(await db.query('SELECT inbox_public_key FROM reward_worker_keys WHERE id=1')).rows[0];
 if(!wk)fail('SETUP_REQUIRED','The worker has not published its key yet — start the worker first',409);
 if(wk.inbox_public_key!==inboxPublicKey)fail('INBOX_KEY_CHANGED','The worker key changed; reload the dashboard and paste the key again',409);
 const id=crypto.randomUUID();
 try{await db.query('INSERT INTO reward_key_inbox(id,funding_wallet,address,inbox_public_key,ephemeral_public_key,iv,ciphertext,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,fw.id,fw.address,inboxPublicKey,ephemeralPublicKey,iv,ciphertext,actor]);}
 catch(e){if(e.code==='23505')fail('ALREADY_PENDING','A key for this wallet is already waiting for the worker',409);throw e;}
 await Logs.log(db,{severity:'warn',component:'admin',eventType:'fee_wallet_key_sealed',mint:fw.mint,message:`Sealed fee-wallet key for ${fw.address} handed to the worker by ${actor} (the server cannot read it)`});
 return{id,fundingWallet:fw.id,state:'pending'};
}
module.exports={inboxKey,ensureMasterKey,publish,processInbox,submit,wipeKeypair};
