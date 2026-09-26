'use strict';
// Password access to the admin dashboard. The password is kept only as a scrypt hash in
// reward_admin_auth; a session is an HMAC-signed token (12 h) bound to session_version, so a
// password change logs every other session out. Five wrong attempts lock the login for 15 minutes.
// A password session can manage the dashboard; it never signs Solana transactions (program actions
// still need the admin wallet's own signature, holder deposits the fee wallet's).
const crypto=require('node:crypto');
const fail=(code,message,status=400)=>{throw Object.assign(Error(message),{code,status});};
const SESSION_MS=12*3600*1000,MAX_FAILED=5,LOCK_MS=15*60*1000,MIN_LEN=10;
const b64u=b=>Buffer.from(b).toString('base64url');

function hashPassword(password,{N=16384,r=8,p=1}={}){
 const salt=crypto.randomBytes(16),key=crypto.scryptSync(password.normalize('NFKC'),salt,64,{N,r,p,maxmem:64*1024*1024});
 return['scrypt',N,r,p,salt.toString('base64'),key.toString('base64')].join('$');
}
function verifyPassword(password,stored){
 const m=/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored||'');if(!m)return false;
 const expected=Buffer.from(m[5],'base64'),got=crypto.scryptSync(String(password).normalize('NFKC'),Buffer.from(m[4],'base64'),expected.length,{N:+m[1],r:+m[2],p:+m[3],maxmem:64*1024*1024});
 return got.length===expected.length&&crypto.timingSafeEqual(got,expected);
}
const sha256=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
function sessionKey(env=process.env){
 const seed=env.REWARDS_ADMIN_SESSION_SECRET||env.SUPABASE_SECRET_KEY||env.DATABASE_URL;
 if(!seed)fail('SETUP_REQUIRED','Admin sessions are not configured on this host.',503);
 return crypto.createHash('sha256').update('rebound-admin-session-v1|'+seed).digest();
}
function issue(version,{now=Date.now(),env}={}){
 const body=b64u(JSON.stringify({v:version,iat:now,exp:now+SESSION_MS}));
 return{token:body+'.'+b64u(crypto.createHmac('sha256',sessionKey(env)).update(body).digest()),expiresAt:new Date(now+SESSION_MS).toISOString()};
}
function parse(token,{now=Date.now(),env}={}){
 const [body,mac]=String(token||'').split('.');if(!body||!mac)return null;
 const want=crypto.createHmac('sha256',sessionKey(env)).update(body).digest(),got=Buffer.from(mac,'base64url');
 if(got.length!==want.length||!crypto.timingSafeEqual(got,want))return null;
 let c;try{c=JSON.parse(Buffer.from(body,'base64url').toString());}catch{return null;}
 return Number.isInteger(c.v)&&c.exp>now?c:null;
}
const row=async db=>(await db.query('SELECT * FROM reward_admin_auth WHERE id=1')).rows[0];
const strong=p=>{if(typeof p!=='string'||p.length<MIN_LEN||p.length>200)fail('WEAK_PASSWORD',`Use at least ${MIN_LEN} characters.`);return p;};

async function state(db){const r=await row(db);return{passwordSet:!!r?.password_hash,setupOpen:!r?.password_hash&&!!r?.setup_hash&&(!r.setup_expires||new Date(r.setup_expires)>new Date())};}

async function login(db,{password},opts={}){
 const r=await row(db);if(!r?.password_hash)fail('SETUP_REQUIRED','No admin password yet. Use the one-time setup code.',409);
 if(r.locked_until&&new Date(r.locked_until)>new Date())fail('LOCKED','Too many wrong attempts. Try again in a few minutes.',429);
 if(!verifyPassword(String(password||''),r.password_hash)){
  const failed=r.failed+1;await db.query('UPDATE reward_admin_auth SET failed=$1,locked_until=$2,updated_at=now() WHERE id=1',[failed>=MAX_FAILED?0:failed,failed>=MAX_FAILED?new Date(Date.now()+LOCK_MS):null]);
  fail('WRONG_PASSWORD','Wrong password.',401);
 }
 await db.query('UPDATE reward_admin_auth SET failed=0,locked_until=NULL WHERE id=1');
 return issue(r.session_version,opts);
}
async function setup(db,{code,password},opts={}){
 const r=await row(db);if(r?.password_hash)fail('ALREADY_SET','The admin password is already set. Sign in instead.',409);
 if(!r?.setup_hash||(r.setup_expires&&new Date(r.setup_expires)<=new Date()))fail('SETUP_CLOSED','No valid setup code. Ask the operator to issue a new one.',409);
 const a=Buffer.from(sha256(String(code||'').trim()),'hex'),b=Buffer.from(r.setup_hash,'hex');
 if(!crypto.timingSafeEqual(a,b)){await db.query('UPDATE reward_admin_auth SET failed=failed+1 WHERE id=1');fail('WRONG_CODE','Wrong setup code.',401);}
 const v=r.session_version+1;
 await db.query('UPDATE reward_admin_auth SET password_hash=$1,setup_hash=NULL,setup_expires=NULL,session_version=$2,failed=0,locked_until=NULL,updated_at=now() WHERE id=1',[hashPassword(strong(password)),v]);
 return issue(v,opts);
}
async function change(db,{current,next},opts={}){
 const r=await row(db);if(!verifyPassword(String(current||''),r?.password_hash))fail('WRONG_PASSWORD','The current password is wrong.',401);
 const v=r.session_version+1;
 await db.query('UPDATE reward_admin_auth SET password_hash=$1,session_version=$2,failed=0,locked_until=NULL,updated_at=now() WHERE id=1',[hashPassword(strong(next)),v]);
 return issue(v,opts);
}
/** Returns the password session for this request, or null. */
async function session(db,headers,opts={}){
 const t=headers?.['x-admin-session']||headers?.['X-Admin-Session'];if(!t)return null;
 const c=parse(t,opts);if(!c)return null;const r=await row(db);return r&&c.v===r.session_version?{via:'password',actor:'admin (password)',expiresAt:new Date(c.exp).toISOString()}:null;
}
module.exports={hashPassword,verifyPassword,sha256,issue,parse,state,login,setup,change,session,MIN_LEN};
