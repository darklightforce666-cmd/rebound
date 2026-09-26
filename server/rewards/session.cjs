'use strict';
// Supabase Auth is the session authority (spec §12). Netlify functions verify the caller's
// access token with Supabase Auth itself (GET /auth/v1/user: rejects expired, revoked or
// forged sessions) and derive identity only from server-controlled fields:
//   user.id and identities[].provider_id = "web3:solana:<address>" (set by Supabase Auth
//   after it verified the Sign-In-With-Solana signature).
// user_metadata is user-writable and is never used for authorization. Roles are server-side:
// admin = verified wallet ∈ reward_admin_wallets (unrevoked) with a REBOUND sign-in domain.
const W=require('./wire.cjs');

class AuthError extends Error{constructor(code,message,status){super(message);this.code=code;this.status=status;}}

function authConfig(env=process.env){
 const url=env.SUPABASE_URL||'',publishableKey=env.SUPABASE_PUBLISHABLE_KEY||'';
 return{url:url.replace(/\/+$/,''),publishableKey,configured:/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url.replace(/\/+$/,''))&&publishableKey.length>20};
}

function bearer(headers={}){
 const h=headers.authorization||headers.Authorization||'';const m=/^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(h);return m?m[1]:null;
}

// Pure: extract verified Solana wallets (with the domain of their latest SIWS sign-in).
function verifiedWallets(user){
 const out=[];for(const i of user?.identities||[]){
  if(i?.provider!=='web3'||typeof i.id!=='string'&&typeof i.provider_id!=='string')continue;
  const pid=i.provider_id||i.id;const m=/^web3:solana:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(pid||'');if(!m)continue;
  try{if(W.pk(m[1]).toBase58()!==m[1])continue;}catch{continue;}
  const claims=i.identity_data?.custom_claims||{};
  out.push({wallet:m[1],domain:typeof claims.domain==='string'?claims.domain:null});
 }return out;
}

async function fetchUser(token,cfg=authConfig(),fetchImpl=fetch){
 if(!cfg.configured)throw new AuthError('AUTH_UNAVAILABLE','Sign-in is not configured yet.',503);
 if(!token)throw new AuthError('UNAUTHORIZED','Sign in with your wallet first.',401);
 let response;try{response=await fetchImpl(cfg.url+'/auth/v1/user',{headers:{apikey:cfg.publishableKey,authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});}
 catch{throw new AuthError('AUTH_UNAVAILABLE','Sign-in service is temporarily unavailable.',503);}
 if(response.status===401||response.status===403)throw new AuthError('UNAUTHORIZED','Your session expired. Sign in again.',401);
 if(!response.ok)throw new AuthError('AUTH_UNAVAILABLE','Sign-in service is temporarily unavailable.',503);
 const user=await response.json();if(!user||typeof user.id!=='string'||!/^[0-9a-f-]{36}$/.test(user.id))throw new AuthError('UNAUTHORIZED','Invalid session.',401);
 return user;
}

async function roles(db,user){
 const wallets=verifiedWallets(user);
 const domains=new Set((await db.query('SELECT domain FROM reward_allowed_auth_domains')).rows.map(r=>r.domain));
 const reboundWallets=wallets.filter(w=>w.domain&&domains.has(w.domain)).map(w=>w.wallet);
 const admins=reboundWallets.length?(await db.query('SELECT wallet FROM reward_admin_wallets WHERE revoked_at IS NULL AND wallet=ANY($1::text[])',[reboundWallets])).rows.map(r=>r.wallet):[];
 return{userId:user.id,wallets:wallets.map(w=>w.wallet),reboundWallets,adminWallets:admins,admin:admins.length>0};
}

// Resolve the caller. `require` = 'user' | 'admin'.
async function authenticate(db,headers,{need='user',cfg=authConfig(),fetchImpl=fetch}={}){
 const user=await fetchUser(bearer(headers),cfg,fetchImpl),r=await roles(db,user);
 if(!r.wallets.length)throw new AuthError('FORBIDDEN','Sign in with a Solana wallet.',403);
 if(need==='admin'&&!r.admin)throw new AuthError('FORBIDDEN','This account is not a REBOUND administrator.',403);
 return r;
}
function ownsWallet(session,wallet){return session.reboundWallets.includes(wallet);}

module.exports={AuthError,authConfig,bearer,verifiedWallets,fetchUser,roles,authenticate,ownsWallet};
