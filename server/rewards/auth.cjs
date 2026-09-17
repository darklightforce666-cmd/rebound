'use strict';
const crypto=require('node:crypto'),W=require('./wire.cjs'),P=require('./policy.cjs'),DB=require('./db.cjs');
const actions=new Set(['metadata-upload','launch-prepare','launch-next','launch-submit','claim']);
function payloadHash(action,payload){if(!actions.has(action))throw Error('Unsupported signed action');return W.hash(P.stable({action,payload})).toString('hex');}
async function challenge(db,{wallet,action,payload,origin}){
 W.pk(wallet);const id=crypto.randomUUID(),expires=new Date(Date.now()+120000);
 const message=`rebound wallet authorization\nOrigin: ${origin}\nWallet: ${wallet}\nAction: ${action}\nRequest: ${payloadHash(action,payload)}\nNonce: ${id}\nExpires: ${expires.toISOString()}\nThis message does not transfer funds.`;
 await db.query('INSERT INTO reward_challenges(id,wallet,message,expires_at) VALUES($1,$2,$3,$4)',[id,wallet,message,expires]);return{id,message,expires:expires.toISOString()};
}
function validSignature(wallet,message,signature){try{const raw=Buffer.from(signature,'base64');if(raw.length!==64)return false;const key=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),W.key(wallet)]),format:'der',type:'spki'});return crypto.verify(null,Buffer.from(message),key,raw);}catch{return false;}}
async function authenticate(db,{wallet,action,payload,origin,proof}){
 if(!proof?.id||!proof.signature)throw Error('Wallet authorization required');
 return DB.transaction(db,async tx=>{const row=(await tx.query('SELECT * FROM reward_challenges WHERE id=$1 FOR UPDATE',[proof.id])).rows[0];if(!row||row.used_at||new Date(row.expires_at)<=new Date()||row.wallet!==wallet||!row.message.includes('\nOrigin: '+origin+'\n')||!row.message.includes('\nAction: '+action+'\nRequest: '+payloadHash(action,payload)+'\n')||!validSignature(wallet,row.message,proof.signature))throw Error('Invalid or expired wallet authorization');await tx.query('UPDATE reward_challenges SET used_at=now() WHERE id=$1',[proof.id]);return wallet;});
}
async function rateLimit(db,bucket,limit=30){const window=Math.floor(Date.now()/60000),row=(await db.query('INSERT INTO reward_rate_limits(bucket,window_start,requests) VALUES($1,$2,1) ON CONFLICT(bucket,window_start) DO UPDATE SET requests=reward_rate_limits.requests+1 RETURNING requests',[W.hash(bucket).toString('hex'),window])).rows[0];if(row.requests>limit)throw Error('Please wait before retrying.');}
module.exports={payloadHash,challenge,validSignature,authenticate,rateLimit};
