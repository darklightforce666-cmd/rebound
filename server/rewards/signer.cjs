'use strict';
// Automatic primary funding signer (spec §5.1, §11.2). Encrypted at rest with AES-256-GCM.
// The master key is a 32-byte secret in a file on the scheduler host only
// (REWARDS_SIGNER_MASTER_KEY_FILE); it is never stored in Supabase, Netlify, the browser or logs.
// Supabase stores ciphertext + iv + tag + public address + readiness. Only rebound_scheduler can
// read the ciphertext, and without the master key it is useless.
const crypto=require('node:crypto'),fs=require('node:fs/promises');
const {Keypair}=require('@solana/web3.js'),bs58=require('bs58');
const ROLES=new Set(['primary_dev','fee_payer','publisher','verifier']);

async function masterKey(env=process.env){
 const file=env.REWARDS_SIGNER_MASTER_KEY_FILE;if(!file)throw Object.assign(Error('Signer master key is not configured on this host'),{code:'SIGNER_UNCONFIGURED'});
 const stat=await fs.stat(file);if((stat.mode&0o077)!==0)throw Object.assign(Error('Signer master key file must not be readable by group/other (chmod 600)'),{code:'SIGNER_INSECURE'});
 const raw=(await fs.readFile(file,'utf8')).trim();const key=/^[0-9a-f]{64}$/i.test(raw)?Buffer.from(raw,'hex'):Buffer.from(raw,'base64');
 if(key.length!==32)throw Object.assign(Error('Signer master key must be 32 bytes (hex or base64)'),{code:'SIGNER_INVALID'});return key;
}
// Parse a documented secret-key format into a Keypair; wipes intermediate buffers.
function parseSecret(text){
 const t=String(text).trim();let bytes=null;
 try{
  if(t.startsWith('[')){const arr=JSON.parse(t);if(!Array.isArray(arr)||arr.length!==64||arr.some(n=>!Number.isInteger(n)||n<0||n>255))throw 0;bytes=Uint8Array.from(arr);}
  else{const d=bs58.decode(t);if(d.length!==64)throw 0;bytes=Uint8Array.from(d);d.fill(0);}
  const kp=Keypair.fromSecretKey(Uint8Array.from(bytes));return kp;   // copy: the wipe below must not zero the key
 }catch{throw Object.assign(Error('Unsupported key format: use a solana-keygen JSON array or a base58 64-byte secret key'),{code:'SIGNER_FORMAT'});}
 finally{if(bytes)bytes.fill(0);}
}
function encrypt(master,secret,aad){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',master,iv);c.setAAD(Buffer.from(aad));const ct=Buffer.concat([c.update(Buffer.from(secret)),c.final()]);return{ciphertext:ct,iv,tag:c.getAuthTag()};}
function decrypt(master,{ciphertext,iv,auth_tag},aad){const d=crypto.createDecipheriv('aes-256-gcm',master,Buffer.from(iv));d.setAAD(Buffer.from(aad));d.setAuthTag(Buffer.from(auth_tag));return Buffer.concat([d.update(Buffer.from(ciphertext)),d.final()]);}
const aadFor=(role,address,id)=>`rebound-signer:v1:${role}:${address}:${id}`;

// Import: returns ONLY {id, address, status}. `expectedAddress` must match the derived key.
async function importSigner(db,{role,secretText,expectedAddress,env=process.env}){
 if(!ROLES.has(role))throw Object.assign(Error('Unknown signer role'),{code:'SIGNER_ROLE'});
 const master=await masterKey(env),kp=parseSecret(secretText),address=kp.publicKey.toBase58();
 try{
  if(expectedAddress&&address!==expectedAddress)throw Object.assign(Error('Key does not belong to the configured wallet '+expectedAddress),{code:'SIGNER_MISMATCH'});
  const id=crypto.randomUUID(),enc=encrypt(master,kp.secretKey,aadFor(role,address,id));
  await db.query("INSERT INTO reward_signers(id,address,role,storage,ciphertext,iv,auth_tag,key_version,status) VALUES($1,$2,$3,'encrypted_local',$4,$5,$6,1,'ready')",[id,address,role,enc.ciphertext,enc.iv,enc.tag]);
  return{id,address,status:'ready'};
 }finally{kp.secretKey.fill(0);master.fill(0);}
}
// Load for signing (scheduler only). Verifies decrypted key → address, and that it is not revoked.
async function load(db,id,{env=process.env}={}){
 const row=(await db.query('SELECT * FROM reward_signers WHERE id=$1',[id])).rows[0];
 if(!row||row.status!=='ready')throw Object.assign(Error('Signer is not ready'),{code:'SIGNER_NOT_READY'});
 const master=await masterKey(env);let secret;
 try{secret=decrypt(master,row,aadFor(row.role,row.address,row.id));const kp=Keypair.fromSecretKey(Uint8Array.from(secret));
  if(kp.publicKey.toBase58()!==row.address)throw Object.assign(Error('Signer integrity check failed'),{code:'SIGNER_INTEGRITY'});return kp;}
 catch(e){if(e.code)throw e;throw Object.assign(Error('Signer cannot be decrypted with this host key'),{code:'SIGNER_DECRYPT'});}
 finally{master.fill(0);if(secret)secret.fill(0);}
}
// Health: prove we can decrypt and that the address matches, without exposing anything.
async function health(db,id,opts){
 let ok=false,code=null;try{const kp=await load(db,id,opts);kp.secretKey.fill(0);ok=true;}catch(e){code=e.code||'SIGNER_ERROR';}
 await db.query('UPDATE reward_signers SET last_health_at=now(),last_health_ok=$2 WHERE id=$1',[id,ok]);return{ok,code};
}
async function revoke(db,id){await db.query("UPDATE reward_signers SET status='revoked',revoked_at=now(),ciphertext=NULL,iv=NULL,auth_tag=NULL,storage='managed',external_reference='revoked' WHERE id=$1",[id]);}
module.exports={parseSecret,importSigner,load,health,revoke,masterKey};
