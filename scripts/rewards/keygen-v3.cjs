#!/usr/bin/env node
'use strict';
// Generate REBOUND V3 operator keypairs on the machine that will hold them (worker host or the
// owner's Mac). Secret files are written with mode 600 in a mode-700 directory, never printed,
// never overwritten. Output: public addresses and an env snippet only.
//
//   node scripts/rewards/keygen-v3.cjs --out ./runtime-secrets --roles program,admin,publisher,verifier,guardian,fee_payer
//
// Roles: program (program id keypair, used once by `solana program deploy`), admin (upgrade authority
// + deployment admin — for a private test only; production should use a Ledger or a Squads multisig),
// publisher, verifier, guardian (pause only), fee_payer (operations: fees, rent, collection cranks; also creates
// the worker's signer-master.key and inbox.jwk).
const fs=require('node:fs'),path=require('node:path');const {Keypair}=require('@solana/web3.js');
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d;};
const ROLES=new Set(['program','admin','publisher','verifier','guardian','fee_payer']);
const out=path.resolve(arg('out','./runtime-secrets')),roles=String(arg('roles','publisher,verifier,guardian,fee_payer')).split(',').map(s=>s.trim()).filter(Boolean);
for(const r of roles)if(!ROLES.has(r)){console.error('Unknown role '+r);process.exit(2);}
fs.mkdirSync(out,{recursive:true,mode:0o700});fs.chmodSync(out,0o700);
const env={publisher:'REWARDS_PUBLISHER',verifier:'REWARDS_VERIFIER',guardian:'REWARDS_GUARDIAN',fee_payer:'REWARDS_FEE_PAYER',admin:'REWARDS_ADMIN',program:'REWARDS_PROGRAM'};
const lines=[],summary=[];
for(const role of roles){
 const file=path.join(out,role+'.json');
 let kp;if(fs.existsSync(file)){kp=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file,'utf8'))));summary.push([role,kp.publicKey.toBase58(),'existing']);}
 else{kp=Keypair.generate();fs.writeFileSync(file,JSON.stringify(Array.from(kp.secretKey)),{mode:0o600,flag:'wx'});summary.push([role,kp.publicKey.toBase58(),'created']);}
 fs.chmodSync(file,0o600);
 if(role==='program')lines.push(`REWARDS_PROGRAM_ID=${kp.publicKey.toBase58()}`);
 else{lines.push(`${env[role]}_ADDRESS=${kp.publicKey.toBase58()}`);if(role!=='admin'&&role!=='guardian')lines.push(`${env[role]}_KEY_FILE=${file}`);}
}
// Worker host secrets (created with the fee_payer role): the signer master key that encrypts imported
// fee-wallet keys at rest, and the X25519 key-inbox key the admin dashboard seals fee-wallet keys to.
if(roles.includes('fee_payer')){
 const crypto=require('node:crypto');
 const master=path.join(out,'signer-master.key'),inbox=path.join(out,'inbox.jwk');
 if(!fs.existsSync(master)){fs.writeFileSync(master,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});summary.push(['signer-master','(secret file)','created']);}else summary.push(['signer-master','(secret file)','existing']);
 if(!fs.existsSync(inbox)){const j=crypto.generateKeyPairSync('x25519').privateKey.export({format:'jwk'});fs.writeFileSync(inbox,JSON.stringify({kty:'OKP',crv:'X25519',d:j.d,x:j.x}),{mode:0o600,flag:'wx'});summary.push(['key-inbox',j.x,'created']);}
 else summary.push(['key-inbox',JSON.parse(fs.readFileSync(inbox,'utf8')).x,'existing']);
 fs.chmodSync(master,0o600);fs.chmodSync(inbox,0o600);
 lines.push(`REWARDS_SIGNER_MASTER_KEY_FILE=${master}`,`REWARDS_INBOX_KEY_FILE=${inbox}`);
}
for(const [r,a,s] of summary)console.log(`${r.padEnd(10)} ${a}  (${s})`);
console.log('\n# env snippet (public addresses and file paths only)\n'+lines.join('\n'));
