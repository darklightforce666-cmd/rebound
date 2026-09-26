'use strict';
// One-time action consent (spec §12). A signed message proves control and consent for ONE
// server-side action. It never grants native-SOL spending authority: any SOL movement is a
// separate transaction the wallet (or a program-controlled account) must sign.
const crypto=require('node:crypto');
const W=require('./wire.cjs'),{stable}=require('./policy.cjs'),DB=require('./db.cjs');
const {AuthError,ownsWallet}=require('./session.cjs');

const ACTIONS=new Set(['metadata-upload','launch-prepare','launch-next','launch-submit','activation-prepare','activation-confirm',
 'admin-register-primary','admin-connect-funding-wallet','admin-set-mode','admin-start','admin-pause','admin-resume','admin-approve-funding','admin-retry','admin-test-config','admin-add-admin','admin-revoke-admin','admin-opening-credit','admin-site','admin-launch']);
const TTL_MS=120000;
const payloadHash=(action,payload)=>{if(!ACTIONS.has(action))throw new AuthError('FORBIDDEN','Unsupported signed action',403);return W.hash(stable({action,payload})).toString('hex');};

function message({domain,wallet,action,hash,nonce,expires,binding}){
 const lines=[`${domain} wants you to approve one REBOUND action with your Solana account:`,wallet,'',
  'This signature approves only the action below. It does not send a transaction, move SOL or tokens, or authorize future spending.','',
  `Action: ${action}`,`Request: ${hash}`];
 for(const k of ['mint','policy','fundingMode','targetPrimaryMint'])if(binding[k])lines.push(`${k[0].toUpperCase()+k.slice(1)}: ${binding[k]}`);
 lines.push(`Nonce: ${nonce}`,`Expires: ${expires}`);return lines.join('\n');
}

async function challenge(db,session,{origin,wallet,action,payload,binding:_ignored}){
 // Display lines are taken from the hashed payload itself, never from caller-supplied text.
 const binding={};for(const k of ['mint','policy','fundingMode','targetPrimaryMint'])if(payload&&(typeof payload[k]==='string'||typeof payload[k]==='number'))binding[k]=String(payload[k]).slice(0,100);
 const domain=new URL(origin).host;W.pk(wallet);
 if(!ownsWallet(session,wallet))throw new AuthError('FORBIDDEN','Sign in with this wallet first.',403);
 const nonce=crypto.randomUUID(),expires=new Date(Date.now()+TTL_MS).toISOString(),hash=payloadHash(action,payload);
 const text=message({domain,wallet,action,hash,nonce,expires,binding});
 await db.query('INSERT INTO reward_challenges(id,wallet,message,expires_at,user_id,action,domain,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[nonce,wallet,text,expires,session.userId,action,domain,hash]);
 return{id:nonce,message:text,expires};
}

function validSignature(wallet,text,signature){
 try{const raw=Buffer.from(signature,'base64');if(raw.length!==64)return false;
  const key=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),W.key(wallet)]),format:'der',type:'spki'});
  return crypto.verify(null,Buffer.from(text),key,raw);}catch{return false;}
}

// Consumes the consent exactly once. Binds user, wallet, domain, action and exact payload.
async function consume(db,session,{origin,wallet,action,payload,proof}){
 if(!proof?.id||!proof?.signature)throw new AuthError('FORBIDDEN','Wallet approval required.',403);
 const domain=new URL(origin).host,hash=payloadHash(action,payload);
 return DB.transaction(db,async tx=>{
  const row=(await tx.query('SELECT * FROM reward_challenges WHERE id=$1 FOR UPDATE',[proof.id])).rows[0];
  const ok=row&&!row.used_at&&new Date(row.expires_at)>new Date()&&row.user_id===session.userId&&row.wallet===wallet&&ownsWallet(session,wallet)
   &&row.domain===domain&&row.action===action&&row.payload_hash===hash&&validSignature(wallet,row.message,proof.signature);
  if(!ok)throw new AuthError('FORBIDDEN','Invalid or expired wallet approval.',403);
  await tx.query('UPDATE reward_challenges SET used_at=now() WHERE id=$1',[proof.id]);
  return{wallet,nonce:row.id,messageHash:W.hash(row.message).toString('hex')};
 });
}
module.exports={ACTIONS,payloadHash,message,challenge,validSignature,consume};
