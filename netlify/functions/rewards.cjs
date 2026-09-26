'use strict';
// REBOUND short API (Netlify Functions). Contract: docs/API-V3.md.
// Public reads use sanitized projections. Every mutation requires a verified Supabase
// session, a bounded validated body, an allowed Origin and (where it changes state on behalf
// of a wallet) a one-time signed consent. Browsers never supply amounts, eligibility, roles
// or transaction instructions. Long-running work belongs to the worker, not to this function.
const crypto=require('node:crypto');
const DB=require('../../server/rewards/db.cjs'),P=require('../../server/rewards/policy.cjs'),P3=require('../../server/rewards/policy-v3.cjs');
const W=require('../../server/rewards/wire.cjs'),Auth=require('../../server/rewards/auth.cjs'),Session=require('../../server/rewards/session.cjs');
const Consent=require('../../server/rewards/consent.cjs'),Logs=require('../../server/rewards/logs.cjs'),Metadata=require('../../server/rewards/metadata.cjs');
const Cycle=require('../../server/rewards/cycle-v3.cjs');

let pool;
const MAX_BODY=3000000;
function origins(env=process.env){
 const list=[env.PUBLIC_SITE_ORIGIN||'https://rebound.wtf',...String(env.ALLOWED_ORIGINS||'').split(',')].map(s=>s.trim()).filter(Boolean);
 return new Set(list.filter(o=>{try{const u=new URL(o);return u.origin===o&&(u.protocol==='https:'||u.hostname==='localhost'||u.hostname==='127.0.0.1');}catch{return false;}}));
}
function headersFor(event,extra={}){
 const h={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...extra};
 const o=event.headers?.origin;if(o&&origins().has(o)){h['access-control-allow-origin']=o;h.vary='Origin';}
 return h;
}
const reply=(event,statusCode,value,extra)=>({statusCode,headers:headersFor(event,extra),body:P.stable(value)});
class ApiError extends Error{constructor(status,code,message,retryable=false,extra={}){super(message);Object.assign(this,{status,code,retryable,extra});}}
const fail=(status,code,message,retryable=false,extra)=>{throw new ApiError(status,code,message,retryable,extra);};

async function publicConfig(db){
 const platform=db?(await db.query('SELECT namespace,execution_mode,policy_version,primary_mint,paused FROM reward_platform ORDER BY namespace')).rows:[];
 return{
  site:process.env.PUBLIC_SITE_ORIGIN||'https://rebound.wtf',
  supabase:{url:process.env.SUPABASE_URL||null,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY||null},
  privy:{appId:process.env.PRIVY_APP_ID||null},
  policy:{version:P3.POLICY.version,hash:P3.POLICY_HASH,holdersBps:P3.POLICY.holdersBps,otherBps:P3.POLICY.otherBps,cycleSeconds:P3.POLICY.cycleSeconds,cutoffLeadSeconds:P3.POLICY.cutoffLeadSeconds,lossUnit:P3.POLICY.lossUnit,asset:P3.POLICY.asset,referencePrice:P3.POLICY.referencePrice,priceWindowSeconds:P3.POLICY.priceWindowSeconds},
  namespaces:platform.map(p=>({namespace:p.namespace,executionMode:p.execution_mode,policyVersion:p.policy_version,primaryMint:p.primary_mint,paused:p.paused})),
  features:{launches:false,rewards:false,buyback:false},
 };
}

// Chain access for owner-signed transactions (manual primary funding). Fails closed when unset.
let chainPorts;
function chain(db){
 if(!process.env.SOLANA_RPC_URL||!process.env.REWARDS_PROGRAM_ID)fail(503,'SETUP_REQUIRED','Settlement is not configured yet. Nothing was changed.',true);
 if(!chainPorts){const {Connection,PublicKey}=require('@solana/web3.js');const connection=new Connection(process.env.SOLANA_RPC_URL,'confirmed');
  chainPorts={connection,program:new PublicKey(process.env.REWARDS_PROGRAM_ID),now:async()=>connection.getBlockTime(await connection.getSlot('finalized'))};}
 return{...chainPorts,db};
}
const PLAN_ERRORS={FORBIDDEN:403,PLAN_STALE:409,PLAN_EXPIRED:409,INVALID_TRANSACTION:400,TRANSACTION_TOO_LARGE:400};
async function planCall(fn){try{return await fn();}catch(e){if(PLAN_ERRORS[e.code])fail(PLAN_ERRORS[e.code],e.code,e.message);throw e;}}
const validMint=m=>{try{W.pk(m);return m;}catch{fail(400,'MINT_INVALID','Invalid mint address');}};

const PAGE=24;
async function tokens(db,q){
 const namespace=q.view==='test'?'mainnet_test':'production',limit=Math.min(Math.max(Number(q.limit)||PAGE,1),50);
 const before=q.cursor&&/^\d+:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.cursor)?q.cursor.split(':'):null;
 const rows=(await db.query(`SELECT * FROM reward_public_tokens WHERE namespace=$1 ${before?'AND (pinned=false AND (COALESCE(launch_time,0),mint)<($2::bigint,$3))':''}
  ORDER BY pinned DESC, COALESCE(launch_time,0) DESC, mint DESC LIMIT ${limit+1}`,before?[namespace,before[0],before[1]]:[namespace])).rows;
 const page=rows.slice(0,limit),last=page.at(-1);
 return{tokens:page,next:rows.length>limit&&last?`${last.launch_time||0}:${last.mint}`:null,namespace};
}

async function body(event){
 if(event.isBase64Encoded||Buffer.byteLength(event.body||'')>MAX_BODY)fail(413,'PAYLOAD_TOO_LARGE','Request too large');
 try{const v=JSON.parse(event.body||'{}');if(!v||typeof v!=='object'||Array.isArray(v))throw 0;return v;}catch{fail(400,'INVALID_BODY','Invalid request body');}
}

const handlers={
 GET:{
  async config({db}){return publicConfig(db);},
  async health({db,event}){
   if(!db)return{available:false,state:'setup_required',transfersEnabled:false,launchesEnabled:false,reason:'Rewards database is not connected.',policy:(await publicConfig(null)).policy};
   const platform=(await db.query('SELECT namespace,execution_mode,paused FROM reward_platform')).rows;
   const worker=(await db.query("SELECT status,heartbeat_at FROM reward_health WHERE component='worker'")).rows[0];
   const stale=!worker||Date.now()-new Date(worker.heartbeat_at).getTime()>120000;
   return{available:true,state:platform.some(p=>p.paused)?'paused':stale?'worker_offline':'ok',transfersEnabled:false,launchesEnabled:false,
    executionModes:Object.fromEntries(platform.map(p=>[p.namespace,p.execution_mode])),worker:worker?{status:worker.status,heartbeatAt:worker.heartbeat_at}:null,policy:(await publicConfig(null)).policy};
  },
  async tokens({db,q}){return tokens(db,q);},
  async token({db,q}){
   try{W.pk(q.mint);}catch{fail(400,'MINT_INVALID','Invalid mint address');}
   const token=(await db.query('SELECT * FROM reward_public_tokens WHERE mint=$1',[q.mint])).rows[0];if(!token)fail(404,'NOT_FOUND','This token is not a verified REBOUND launch.');
   const cycles=(await db.query('SELECT * FROM reward_public_cycles WHERE mint=$1 ORDER BY cycle_number DESC LIMIT 20',[q.mint])).rows;
   return{token,cycles};
  },
  // The exact holder-only deposit the connected dev wallet is asked to sign (manual primary funding).
  async 'funding-plan'({db,event,q}){
   const s=await Session.authenticate(db,event.headers);const mint=validMint(q.mint);
   return{plan:await planCall(()=>Cycle.manualPlan(chain(db),{mint,wallets:s.wallets}))};
  },
  async 'admin-logs'({db,event,q}){
   await Session.authenticate(db,event.headers,{need:'admin'});
   const where=[],args=[];const add=(sql,v)=>{args.push(v);where.push(sql.replace('?','$'+args.length));};
   if(q.mint)add('mint=?',q.mint);if(q.cycle)add('cycle_id=?',q.cycle);if(q.severity)add('severity=?',q.severity);if(q.component)add('component=?',q.component);
   if(q.before&&/^\d+$/.test(q.before))add('id<?',q.before);if(q.search)add("safe_message ILIKE '%'||?||'%'",String(q.search).slice(0,80));
   const rows=(await db.query(`SELECT * FROM reward_logs ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id DESC LIMIT 100`,args)).rows;
   return{logs:rows,next:rows.length===100?rows.at(-1).id:null};
  },
  async 'admin-health'({db,event}){
   await Session.authenticate(db,event.headers,{need:'admin'});
   return{components:(await db.query('SELECT * FROM reward_health ORDER BY component')).rows,now:new Date().toISOString()};
  },
 },
 POST:{
  async session({db,event}){
   const s=await Session.authenticate(db,event.headers);
   return{userId:s.userId,wallets:s.wallets,reboundWallets:s.reboundWallets,admin:s.admin};
  },
  async 'consent-challenge'({db,event,data,origin}){
   const s=await Session.authenticate(db,event.headers);
   return Consent.challenge(db,s,{origin,wallet:data.wallet,action:data.action,payload:data.payload||{},binding:data.binding||{}});
  },
  // Owner-signed holder deposit: verified byte-for-byte against the stored plan, persisted, then broadcast.
  async 'funding-submit'({db,event,data}){
   const s=await Session.authenticate(db,event.headers);const mint=validMint(data.mint);
   if(typeof data.intentId!=='string'||!/^[0-9a-f-]{36}$/.test(data.intentId)||typeof data.signedTransaction!=='string'||data.signedTransaction.length>4000)fail(400,'INVALID_BODY','Invalid funding submission');
   return planCall(()=>Cycle.submitManualDeposit(chain(db),{mint,intentId:data.intentId,serialized:data.signedTransaction,wallets:s.wallets}));
  },
  async 'metadata-upload'({db,event,data,origin,requestId}){
   const s=await Session.authenticate(db,event.headers);const payload=data.payload||{};
   await Consent.consume(db,s,{origin,wallet:data.wallet,action:'metadata-upload',payload,proof:data.proof});
   const result=await Metadata.upload(db,{...payload,createdBy:s.userId,origin});
   await Logs.log(db,{severity:'info',component:'api',eventType:'metadata_uploaded',requestId,message:'Token metadata stored',metadata:{hash:result.hash,wallet:data.wallet}});
   return result;
  },
 },
};

async function legacyAsset(event,q){
 // Compatibility for already published V2 URIs (Netlify Blobs), verified by content hash.
 const result=await Metadata.readLegacy(q.hash);if(!result)return reply(event,404,{code:'NOT_FOUND',message:'Metadata not found'});
 const bytes=Buffer.from(result.data);if(W.hash(bytes).toString('hex')!==q.hash)fail(500,'INTEGRITY','Content hash mismatch');
 return{statusCode:200,headers:{'content-type':result.metadata.mime,'cache-control':'public,max-age=31536000,immutable','x-content-type-options':'nosniff'},body:bytes.toString('base64'),isBase64Encoded:true};
}

exports.handler=async event=>{
 const requestId=crypto.randomUUID(),q=event.queryStringParameters||{},method=event.httpMethod,action=(method==='POST'?q.action:q.action||'health')||'';
 try{
  if(method==='OPTIONS'){const o=event.headers?.origin;if(!origins().has(o))return{statusCode:403,headers:{},body:''};
   return{statusCode:204,headers:{...headersFor(event),'access-control-allow-methods':'GET,POST','access-control-allow-headers':'authorization,content-type,idempotency-key','access-control-max-age':'600'},body:''};}
  if(method==='GET'&&(action==='metadata'||action==='image'))return await legacyAsset(event,q);
  const handler=handlers[method]?.[action];if(!handler)fail(method==='GET'||method==='POST'?404:405,'NOT_FOUND','Unknown endpoint');
  if(!process.env.DATABASE_URL){if(action==='health'||action==='config')return reply(event,200,await handler({db:null,event,q}));fail(503,'SETUP_REQUIRED','REBOUND setup is incomplete. No launch or payout is available yet.',true);}
  pool||=DB.connect(process.env.DATABASE_URL,{max:3,name:'rebound-api'});
  let data={},origin=null;
  if(method==='POST'){
   origin=event.headers?.origin;if(!origin||!origins().has(origin))fail(403,'FORBIDDEN','Open this action from rebound.wtf.');
   data=await body(event);
   await Auth.rateLimit(pool,'ip:'+(event.headers['x-nf-client-connection-ip']||'unknown'),90).catch(e=>fail(429,'RATE_LIMITED',e.message,true));
  }
  return reply(event,200,await handler({db:pool,event,q,data,origin,requestId}));
 }catch(error){
  const known=error instanceof ApiError?error:error instanceof Session.AuthError?new ApiError(error.status,error.code,error.message,error.status>=500):null;
  if(known)return reply(event,known.status,{code:known.code,message:known.message,retryable:known.retryable,requestId,...known.extra});
  const safe=typeof error?.message==='string'&&error.message.length<200&&!/https?:|postgres|password|secret|key file|ECONN|ENOTFOUND|ENOENT|relation|column|syntax/i.test(error.message);
  if(pool)await Logs.log(pool,{severity:'error',component:'api',eventType:'request_failed',requestId,message:Logs.redactText(error?.message||'error'),errorCode:error?.code||'INTERNAL',metadata:{action}}).catch(()=>{});
  return reply(event,safe?400:503,{code:error?.code&&/^[A-Z_]+$/.test(error.code)?error.code:safe?'INVALID_REQUEST':'UNAVAILABLE',message:safe?error.message:'This service is temporarily unavailable. Nothing was changed; retry shortly.',retryable:!safe,requestId});
 }
};
exports._internal={handlers,origins,publicConfig,ApiError};
