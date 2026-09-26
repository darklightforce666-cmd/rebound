'use strict';
// Hosted worker (Supabase Edge Function + pg_cron). One bounded pass per invocation of the same worker
// code that runs on a server (server/rewards/worker-v3.cjs, once mode).
//
// Secrets live in Supabase Vault (names rebound_worker_*), never in the repository or the function source:
//   cron_token  random, created by SQL; the cron job sends it, the function checks it
//   master_key  32 random bytes (hex), created by SQL; encrypts imported fee-wallet keys at rest
//   inbox_jwk   X25519 private JWK, created here on first run (WebCrypto); its public half is published
//   rpc_url     the Solana RPC endpoint, stored by the site's API from its own environment
// The pass uses the injected SUPABASE_DB_URL, with every statement run as the matching REBOUND group role
// (rebound_indexer / rebound_scheduler / rebound_verifier) so per-role privileges still apply.
const crypto=require('node:crypto');
const {Client}=require('pg');
const Seal=require('../../../server/rewards/inbox-seal.cjs');

const PREFIX='rebound_worker_';
async function secrets(dbUrl){
 const c=new Client({connectionString:dbUrl,connectionTimeoutMillis:10000});await c.connect();
 try{
  const read=async()=>Object.fromEntries((await c.query("SELECT name,decrypted_secret FROM vault.decrypted_secrets WHERE name LIKE $1",[PREFIX+'%'])).rows.map(r=>[r.name.slice(PREFIX.length),r.decrypted_secret]));
  let s=await read();
  if(!s.inbox_jwk){const j=await Seal.generate();await c.query('SELECT vault.create_secret($1,$2,$3)',[JSON.stringify(j),PREFIX+'inbox_jwk','REBOUND hosted worker key inbox (X25519 private JWK)']).catch(()=>{});s=await read();}
  return s;
 }finally{await c.end().catch(()=>{});}
}
const same=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y);};

/** Returns {status, body, work?}: `work` is the pass to run in the background (EdgeRuntime.waitUntil). */
async function handle({dbUrl,token}){
 if(!dbUrl)return{status:503,body:{error:'SUPABASE_DB_URL missing'}};
 const s=await secrets(dbUrl);
 if(!same(token,s.cron_token))return{status:401,body:{error:'unauthorized'}};
 if(!s.rpc_url)return{status:200,body:{state:'waiting_for_rpc',hint:'Open the admin dashboard once: the site stores its RPC endpoint for the worker.'}};
 if(!s.master_key)return{status:200,body:{state:'waiting_for_master_key'}};
 Object.assign(process.env,{
  DATABASE_URL:dbUrl,REWARDS_DB_SET_ROLE:'true',REWARDS_WORKER_ROLE:'all',
  SOLANA_RPC_URL:s.rpc_url,...(s.history_rpc_url?{HISTORY_RPC_URL:s.history_rpc_url}:{}),
  REWARDS_SIGNER_MASTER_KEY:s.master_key,REWARDS_INBOX_KEY:s.inbox_jwk,
  REWARDS_MAX_EXECUTION_MODE:s.max_mode||'dry_run',REWARDS_ALLOW_PRODUCTION:'false',
  REWARDS_INGEST_MAX_TX:s.ingest_max_tx||'120',HISTORY_RPC_MIN_INTERVAL_MS:s.rpc_interval_ms||'60',
 });
 const {main}=require('../../../server/rewards/worker-v3.cjs');
 const started=Date.now();
 return{status:202,body:{state:'started'},work:main({role:'all',once:true}).then(()=>({ms:Date.now()-started}))};
}
module.exports={handle};
