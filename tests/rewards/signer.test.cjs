'use strict';
// Automatic signer import (spec §11.2): encrypted at rest, address-bound, never returned.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Keypair}=require('@solana/web3.js'),bs58=require('bs58');
const {supabaseDb}=require('./pg.cjs'),S=require('../../server/rewards/signer.cjs');
function masterFile(mode=0o600){const f=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'rb-master-')),'m.key');fs.writeFileSync(f,crypto.randomBytes(32).toString('hex'),{mode});fs.chmodSync(f,mode);return f;}
test('import accepts keygen JSON and base58, binds the address, stores only ciphertext, and loads back',async()=>{
 const db=await supabaseDb();try{
  const env={REWARDS_SIGNER_MASTER_KEY_FILE:masterFile()},kp=Keypair.generate(),addr=kp.publicKey.toBase58();
  const r=await S.importSigner(db,{role:'primary_dev',secretText:JSON.stringify([...kp.secretKey]),expectedAddress:addr,env});
  assert.deepEqual(Object.keys(r).sort(),['address','id','status']);assert.equal(r.address,addr);
  const row=(await db.query('SELECT * FROM reward_signers WHERE id=$1',[r.id])).rows[0];
  assert.ok(!Buffer.from(row.ciphertext).includes(Buffer.from(kp.secretKey.subarray(0,32))));
  assert.equal((await S.load(db,r.id,{env})).publicKey.toBase58(),addr);
  assert.deepEqual(await S.health(db,r.id,{env}),{ok:true,code:null});
  const b58=Keypair.generate();assert.equal((await S.importSigner(db,{role:'fee_payer',secretText:bs58.encode(b58.secretKey),expectedAddress:b58.publicKey.toBase58(),env})).address,b58.publicKey.toBase58());
 }finally{await db.close();}
});
test('wrong wallet, bad formats, insecure or wrong master keys and tampering are rejected',async()=>{
 const db=await supabaseDb();try{
  const env={REWARDS_SIGNER_MASTER_KEY_FILE:masterFile()},kp=Keypair.generate();
  await assert.rejects(S.importSigner(db,{role:'primary_dev',secretText:JSON.stringify([...kp.secretKey]),expectedAddress:Keypair.generate().publicKey.toBase58(),env}),e=>e.code==='SIGNER_MISMATCH');
  for(const bad of ['[1,2,3]','not-a-key','seed words are not accepted here at all'])await assert.rejects(S.importSigner(db,{role:'primary_dev',secretText:bad,env}),e=>e.code==='SIGNER_FORMAT');
  await assert.rejects(S.importSigner(db,{role:'primary_dev',secretText:JSON.stringify([...kp.secretKey]),env:{REWARDS_SIGNER_MASTER_KEY_FILE:masterFile(0o644)}}),e=>e.code==='SIGNER_INSECURE');
  await assert.rejects(S.importSigner(db,{role:'primary_dev',secretText:JSON.stringify([...kp.secretKey]),env:{}}),e=>e.code==='SIGNER_UNCONFIGURED');
  const r=await S.importSigner(db,{role:'primary_dev',secretText:JSON.stringify([...kp.secretKey]),expectedAddress:kp.publicKey.toBase58(),env});
  await assert.rejects(S.load(db,r.id,{env:{REWARDS_SIGNER_MASTER_KEY_FILE:masterFile()}}),e=>e.code==='SIGNER_DECRYPT');
  await db.query("UPDATE reward_signers SET ciphertext=set_byte(ciphertext,0,(get_byte(ciphertext,0)+1)%256) WHERE id=$1",[r.id]);
  await assert.rejects(S.load(db,r.id,{env}),e=>e.code==='SIGNER_DECRYPT');
  await S.revoke(db,r.id);await assert.rejects(S.load(db,r.id,{env}),e=>e.code==='SIGNER_NOT_READY');
  assert.equal((await db.query('SELECT ciphertext FROM reward_signers WHERE id=$1',[r.id])).rows[0].ciphertext,null);
 }finally{await db.close();}
});
