'use strict';
const crypto=require('node:crypto'),DB=require('./db.cjs'),P=require('./policy.cjs');
function mac(secret,method,path,time,nonce,body){return crypto.createHmac('sha256',secret).update([method,path,time,nonce,body].join('\n')).digest('hex');}
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
async function authenticate(db,{method,path,headers,body},secret){
 if(!secret||secret.length<32)throw Error('Internal authentication is not configured');
 const time=Number(headers['x-rebound-time']),nonce=headers['x-rebound-nonce'],signature=headers['x-rebound-signature'];
 if(!Number.isSafeInteger(time)||Math.abs(Date.now()-time)>30000||!/^[a-f0-9]{32}$/.test(nonce||''))throw Error('Invalid internal authorization');
 if(!equal(mac(secret,method,path,String(time),nonce,body),signature))throw Error('Invalid internal authorization');
 const result=await db.query("INSERT INTO reward_nonce_uses(nonce,expires_at) VALUES($1,now()+interval '2 minutes') ON CONFLICT DO NOTHING RETURNING nonce",[nonce]);if(!result.rows.length)throw Error('Replayed internal request');
}
async function call(path,payload,{url=process.env.REWARDS_VERIFIER_URL,secret=process.env.REWARDS_INTERNAL_SECRET}={}){
 if(!url||!secret||secret.length<32)throw Error('Independent verifier service is not configured');
 const endpoint=new URL(path,url);if(endpoint.protocol!=='https:'&&!['localhost','127.0.0.1','verifier'].includes(endpoint.hostname))throw Error('Verifier endpoint must use HTTPS');
 const body=P.stable(payload),time=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');
 const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-rebound-time':time,'x-rebound-nonce':nonce,'x-rebound-signature':mac(secret,'POST',endpoint.pathname,time,nonce,body)},body,signal:AbortSignal.timeout(20000)});
 const result=await response.json();if(!response.ok)throw Error(result.message||'Verifier unavailable');return result;
}
module.exports={mac,equal,authenticate,call};
