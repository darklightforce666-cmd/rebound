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
// publisher, verifier, guardian (pause only), fee_payer (operations: fees, rent, collection cranks).
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
for(const [r,a,s] of summary)console.log(`${r.padEnd(10)} ${a}  (${s})`);
console.log('\n# env snippet (public addresses and file paths only)\n'+lines.join('\n'));
