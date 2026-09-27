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
const AdminAuth=require('../../server/rewards/admin-auth.cjs'),Cycle=require('../../server/rewards/cycle-v3.cjs'),Launch=require('../../server/rewards/launch-v3.cjs'),Admin=require('../../server/rewards/admin-v3.cjs'),Inbox=require('../../server/rewards/key-inbox.cjs');

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

const effective=mode=>{const R={dry_run:0,mainnet_test:1,production:2},c=require('../../server/rewards/execution.cjs').ceiling();return R[mode]<=R[c]?mode:c;};
async function publicConfig(db){
 const platform=db?(await db.query('SELECT namespace,execution_mode,policy_version,primary_mint,paused FROM reward_platform ORDER BY namespace')).rows:[];
 const s=db?await Admin.site(db).catch(()=>null):null;
 return{
  siteSettings:{open:!!s?.site_open,primaryMint:s?.primary_mint||null,name:s?.primary_name||null,symbol:s?.primary_symbol||null,namespace:s?.namespace||null,updatedAt:s?.updated_at||null},
  site:process.env.PUBLIC_SITE_ORIGIN||'https://rebound.wtf',
  supabase:{url:process.env.SUPABASE_URL||null,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY||null},
  privy:{appId:process.env.PRIVY_APP_ID||s?.privy_app_id||null},
  policy:{version:P3.POLICY.version,hash:P3.POLICY_HASH,holdersBps:P3.POLICY.holdersBps,otherBps:P3.POLICY.otherBps,cycleSeconds:P3.POLICY.cycleSeconds,cutoffLeadSeconds:P3.POLICY.cutoffLeadSeconds,lossUnit:P3.POLICY.lossUnit,asset:P3.POLICY.asset,referencePrice:P3.POLICY.referencePrice,priceWindowSeconds:P3.POLICY.priceWindowSeconds},
  namespaces:platform.map(p=>({namespace:p.namespace,executionMode:effective(p.execution_mode),policyVersion:p.policy_version,primaryMint:p.primary_mint,paused:p.paused})),
  ...(()=>{const by=Object.fromEntries(platform.map(p=>[p.namespace,p]));const ok=(ns,mode)=>by[ns]&&!by[ns].paused&&effective(by[ns].execution_mode)===mode&&by[ns].primary_mint;
   const launchNamespace=ok('production','production')?'production':ok('mainnet_test','mainnet_test')?'mainnet_test':null;
   return{launchNamespace,primaryMint:s?.primary_mint||by.production?.primary_mint||by.mainnet_test?.primary_mint||null,
    features:{launches:!!launchNamespace,rewards:platform.some(p=>effective(p.execution_mode)!=='dry_run'),buyback:!!launchNamespace,privateTest:launchNamespace==='mainnet_test'}};})(),
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
let rpcOnly;const rpcConnection=()=>{if(!process.env.SOLANA_RPC_URL)return null;if(!rpcOnly){const {Connection}=require('@solana/web3.js');rpcOnly=new Connection(process.env.SOLANA_RPC_URL,'confirmed');}return rpcOnly;};
// Admin access: a password session (x-admin-session) or a signed-in administrator wallet.
async function adminAccess(db,event){
 const p=await AdminAuth.session(db,event.headers);
 if(p)return{...p,userId:null,reboundWallets:[],adminWallets:(await db.query('SELECT wallet FROM reward_admin_wallets WHERE revoked_at IS NULL')).rows.map(r=>r.wallet)};
 return{...(await Session.authenticate(db,event.headers,{need:'admin'})),via:'wallet'};
}
const PLAN_ERRORS={FORBIDDEN:403,PLAN_STALE:409,PLAN_EXPIRED:409,INVALID_TRANSACTION:400,TRANSACTION_TOO_LARGE:400,INVALID_BODY:400};
async function planCall(fn){try{return await fn();}catch(e){if(PLAN_ERRORS[e.code])fail(PLAN_ERRORS[e.code],e.code,e.message);if(e.status&&e.code&&/^[A-Z_]+$/.test(e.code))fail(e.status,e.code,e.message,e.status>=500);throw e;}}
const uuid=v=>{if(typeof v!=='string'||!/^[0-9a-f-]{36}$/.test(v))fail(400,'INVALID_BODY','Invalid id');return v;};
const b64tx=v=>{if(typeof v!=='string'||v.length>4000)fail(400,'INVALID_BODY','Invalid transaction');return v;};
const launchPorts=db=>({...chain(db),readMetadata:hash=>Metadata.readMetadata(db,hash)});
// Launches without the on-chain program (direct settlement): an RPC connection is all they need.
const LaunchDirect=require('../../server/rewards/launch-direct.cjs');
async function directLaunches(db,namespace){return((await db.query('SELECT settlement FROM reward_platform WHERE namespace=$1',[namespace])).rows[0]?.settlement||'direct')==='direct';}
const directPorts=db=>{const connection=rpcConnection();if(!connection)fail(503,'SETUP_REQUIRED','Launches are not configured yet. Nothing was changed.',true);return{db,connection,readMetadata:hash=>Metadata.readMetadata(db,hash)};};
async function attemptSettlement(db,id){return(await db.query('SELECT settlement FROM reward_launch_attempts WHERE id=$1',[id])).rows[0]?.settlement||null;}
const validMint=m=>{try{W.pk(m);return m;}catch{fail(400,'MINT_INVALID','Invalid mint address');}};

const PAGE=24;
async function tokens(db,q){
 const namespace=q.view==='test'?'mainnet_test':'production',limit=Math.min(Math.max(Number(q.limit)||PAGE,1),50);
 const before=q.cursor&&/^\d+:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.cursor)?q.cursor.split(':'):null;
 // The site's REBOUND token (set in the admin dashboard) is always listed first, whatever its namespace.
 const featured=(await db.query('SELECT primary_mint FROM reward_site WHERE id=1')).rows[0]?.primary_mint||null;
 const rows=(await db.query(`SELECT t.*,(t.mint=$2) AS featured FROM reward_public_tokens t WHERE (t.namespace=$1 OR t.mint=$2) ${before?'AND (t.mint<>$2 AND t.pinned=false AND (COALESCE(t.launch_time,0),t.mint)<($3::bigint,$4))':''}
  ORDER BY (t.mint=$2) DESC NULLS LAST, t.pinned DESC, COALESCE(t.launch_time,0) DESC, t.mint DESC LIMIT ${limit+1}`,before?[namespace,featured,before[0],before[1]]:[namespace,featured])).rows;
 const page=rows.slice(0,limit),last=page.at(-1);
 return{tokens:page,next:rows.length>limit&&last?`${last.launch_time||0}:${last.mint}`:null,namespace,featured};
}
const HOLDER_SORT={loss:'loss_lamports DESC',paid:'paid_lamports DESC',cost:'cost_lamports DESC',value:'value_lamports DESC'};
// Home page in one read: every listed coin with its holders, its current round and totals, the headline
// round (the REBOUND token's, else the next one to pay) and the latest settled rounds across all coins.
const PAID_STATES=['complete','partially_paid','skipped_no_eligible_holders'];
async function homeData(db){
 const featured=(await db.query('SELECT primary_mint FROM reward_site WHERE id=1')).rows[0]?.primary_mint||null;
 const coins=(await db.query(`SELECT t.mint,t.name,t.symbol,t.image_uri,t.kind,t.launch_time,t.reward_status,t.paid_lamports::text,t.paid_recipients,t.payouts,t.burned_raw::text,t.burns,t.decimals,
  t.history_complete,t.history_fetched,t.history_total,t.positions_time,t.quote_symbol,(t.mint IS NOT DISTINCT FROM $1) AS featured
  FROM reward_public_tokens t WHERE t.namespace='production' OR t.mint=$1 ORDER BY (t.mint IS NOT DISTINCT FROM $1) DESC, t.pinned DESC, COALESCE(t.launch_time,0) DESC, t.mint DESC LIMIT 200`,[featured])).rows;
 const mints=coins.map(c=>c.mint);
 if(!mints.length)return{coins:[],headline:null,rounds:[],featured,now:Math.floor(Date.now()/1000)};
 const holders=Object.fromEntries((await db.query(`SELECT mint,count(*) FILTER (WHERE outcome<>'sold')::int holders,count(*) FILTER (WHERE loss_lamports>0 AND outcome<>'sold')::int underwater
  FROM reward_public_holders WHERE mint=ANY($1) GROUP BY mint`,[mints])).rows.map(r=>[r.mint,r]));
 const current=Object.fromEntries((await db.query(`SELECT DISTINCT ON (mint) mint,cycle_number,state,reason,mode,cutoff_time,scheduled_end,available_lamports::text,holders_underwater,paid_lamports::text,paid_recipients
  FROM reward_public_cycles WHERE mint=ANY($1) ORDER BY mint,cycle_number DESC`,[mints])).rows.map(r=>[r.mint,r]));
 for(const c of coins){c.holders=holders[c.mint]?.holders??0;c.underwater=holders[c.mint]?.underwater??0;c.round=current[c.mint]||null;}
 // Headline: the REBOUND token's round, else the live round that pays out next.
 const now=Math.floor(Date.now()/1000);
 const pick=coins.find(c=>c.featured&&c.round)||coins.filter(c=>c.round&&Number(c.round.scheduled_end)>now-600).sort((a,b)=>Number(a.round.scheduled_end)-Number(b.round.scheduled_end))[0]||null;
 const headline=pick?{mint:pick.mint,symbol:pick.symbol,name:pick.name,history_complete:pick.history_complete,history_fetched:pick.history_fetched,history_total:pick.history_total,positions_time:pick.positions_time,
  cycles:(await db.query('SELECT cycle_number,state,reason,mode,cutoff_time,scheduled_end,available_lamports::text,paid_lamports::text,paid_recipients FROM reward_public_cycles WHERE mint=$1 ORDER BY cycle_number DESC LIMIT 8',[pick.mint])).rows}:null;
 const rounds=(await db.query(`SELECT c.mint,c.cycle_number,c.state,c.available_lamports::text,c.paid_lamports::text,c.paid_recipients,c.scheduled_end,
  (SELECT count(DISTINCT p.signature)::int FROM reward_public_payouts p WHERE p.mint=c.mint AND p.cycle_number=c.cycle_number) AS txs,
  (SELECT p.signature FROM reward_public_payouts p WHERE p.mint=c.mint AND p.cycle_number=c.cycle_number ORDER BY p.id LIMIT 1) AS signature
  FROM reward_public_cycles c WHERE c.mint=ANY($1) AND (c.paid_lamports>0 OR c.state=ANY($2)) ORDER BY c.scheduled_end DESC, c.mint LIMIT 6`,[mints,PAID_STATES])).rows;
 return{coins,headline,rounds,featured,now};
}
// One wallet across every REBOUND coin: its position at the latest snapshot, its share of the current
// round's budget (when the budget is fixed) and everything already paid to it. Read-only, public data.
async function walletCheck(db,q){
 const wallet=(()=>{try{W.pk(q.wallet);return q.wallet;}catch{fail(400,'WALLET_INVALID','That isn’t a Solana address.');}})();
 const rows=(await db.query(`SELECT h.mint,t.name,t.symbol,h.cost_lamports::text,h.value_lamports::text,h.compensated_lamports::text,h.loss_lamports::text,h.paid_lamports::text,h.payouts,h.outcome,
  (SELECT COALESCE(sum(x.loss_lamports),0)::text FROM reward_public_holders x WHERE x.mint=h.mint AND x.outcome<>'sold') AS total_loss,
  (SELECT row_to_json(c) FROM (SELECT cycle_number,state,cutoff_time,scheduled_end,available_lamports::text FROM reward_public_cycles WHERE mint=h.mint ORDER BY cycle_number DESC LIMIT 1) c) AS round
  FROM reward_public_holders h JOIN reward_public_tokens t USING(mint) WHERE h.owner=$1 ORDER BY h.loss_lamports DESC LIMIT 50`,[wallet])).rows;
 const paid=(await db.query('SELECT COALESCE(sum(amount_lamports),0)::text lamports,count(*)::int payouts FROM reward_public_payouts WHERE owner=$1',[wallet])).rows[0];
 for(const r of rows){const total=BigInt(r.total_loss||0),mine=BigInt(r.loss_lamports||0),budget=r.round?.available_lamports!=null?BigInt(r.round.available_lamports):null;
  r.share_bps=total>0n&&mine>0n?Number(mine*10000n/total):0;
  r.estimate_lamports=budget!=null&&total>0n&&mine>0n?String((b=>b>mine?mine:b)(budget*mine/total)):null;}
 return{wallet,positions:rows,paid,now:Math.floor(Date.now()/1000)};
}

async function body(event){
 if(event.isBase64Encoded||Buffer.byteLength(event.body||'')>MAX_BODY)fail(413,'PAYLOAD_TOO_LARGE','Request too large');
 try{const v=JSON.parse(event.body||'{}');if(!v||typeof v!=='object'||Array.isArray(v))throw 0;return v;}catch{fail(400,'INVALID_BODY','Invalid request body');}
}

let rpcShared=null;
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
  async home({db}){return homeData(db);},
  async 'wallet-check'({db,q}){return walletCheck(db,q);},
  async token({db,q}){
   try{W.pk(q.mint);}catch{fail(400,'MINT_INVALID','Invalid mint address');}
   const token=(await db.query('SELECT * FROM reward_public_tokens WHERE mint=$1',[q.mint])).rows[0];if(!token)fail(404,'NOT_FOUND','This token is not a verified REBOUND launch.');
   const cycles=(await db.query('SELECT * FROM reward_public_cycles WHERE mint=$1 ORDER BY cycle_number DESC LIMIT 30',[q.mint])).rows;
   const payouts=(await db.query('SELECT * FROM reward_public_payouts WHERE mint=$1 ORDER BY id DESC LIMIT 50',[q.mint])).rows;
   const stats=(await db.query("SELECT count(*)::int holders, count(*) FILTER (WHERE loss_lamports>0)::int underwater, COALESCE(sum(loss_lamports),0)::text loss, COALESCE(sum(paid_lamports),0)::text paid, count(*) FILTER (WHERE paid_lamports>0)::int paid_holders FROM reward_public_holders WHERE mint=$1 AND outcome<>'sold'",[q.mint])).rows[0];
   return{token,cycles,payouts,stats,now:Math.floor(Date.now()/1000)};
  },
  // Per-holder table (latest snapshot): cost, value now, remaining loss, compensation, payouts.
  async 'token-holders'({db,q}){
   try{W.pk(q.mint);}catch{fail(400,'MINT_INVALID','Invalid mint address');}
   const sort=HOLDER_SORT[q.sort]||HOLDER_SORT.loss,limit=Math.min(Math.max(Number(q.limit)||100,1),500),offset=Math.min(Math.max(Number(q.offset)||0,0),100000);
   const where=q.filter==='paid'?'AND paid_lamports>0':q.filter==='underwater'?'AND loss_lamports>0':q.filter==='all'?'':"AND outcome<>'sold'";
   const rows=(await db.query(`SELECT owner,quantity_raw,cost_lamports,value_lamports,compensated_lamports,loss_lamports,paid_lamports,payouts,outcome,cycle_number,updated_at FROM reward_public_holders WHERE mint=$1 ${where} ORDER BY ${sort}, owner LIMIT ${limit} OFFSET ${offset}`,[q.mint])).rows;
   const total=(await db.query(`SELECT count(*)::int n FROM reward_public_holders WHERE mint=$1 ${where}`,[q.mint])).rows[0].n;
   return{holders:rows,total,offset,limit};
  },
  // Latest payouts across all REBOUND tokens (or one mint), newest first.
  async payouts({db,q}){
   const mint=q.mint?(()=>{try{W.pk(q.mint);return q.mint;}catch{fail(400,'MINT_INVALID','Invalid mint address');}})():null;
   const rows=(await db.query(`SELECT p.*,t.name,t.symbol FROM reward_public_payouts p LEFT JOIN reward_public_tokens t USING(mint) ${mint?'WHERE p.mint=$1':''} ORDER BY p.id DESC LIMIT 50`,mint?[mint]:[])).rows;
   return{payouts:rows};
  },
  // The exact holder-only deposit the connected dev wallet is asked to sign (manual primary funding).
  async 'funding-plan'({db,event,q}){
   const s=await Session.authenticate(db,event.headers);const mint=validMint(q.mint);
   return{plan:await planCall(()=>Cycle.manualPlan(chain(db),{mint,wallets:s.reboundWallets}))};
  },
  async 'launch-status'({db,event,q}){const s=await Session.authenticate(db,event.headers);const id=uuid(q.id);
   if(await attemptSettlement(db,id)==='direct')return planCall(()=>LaunchDirect.status(directPorts(db),{session:s,attemptId:id}));
   return planCall(()=>Launch.status(launchPorts(db),{session:s,attemptId:id}));},
  // Pair assets pump.fun admits right now (SOL first) — the launch form offers only these.
  async 'launch-quotes'({db}){return{quotes:await LaunchDirect.quoteMints(directPorts(db).connection)};},
  async 'admin-overview'({db,event}){const who=await adminAccess(db,event);
   // Hand the hosted worker (Supabase) this site's RPC endpoint: write-only vault function, never read back.
   if(!rpcShared&&process.env.SOLANA_RPC_URL)rpcShared=await db.query('SELECT rebound.worker_store_rpc($1,$2) AS r',[process.env.SOLANA_RPC_URL,process.env.HISTORY_RPC_URL||null]).then(r=>r.rows[0].r).catch(()=>null);
   const ports=process.env.SOLANA_RPC_URL&&process.env.REWARDS_PROGRAM_ID?chain(db):{};const o=await Admin.overview(db,{connection:ports.connection,program:ports.program});
   const st=await Admin.site(db);const meta=st?.primary_mint&&rpcConnection()?await Admin.tokenMeta(rpcConnection(),st.primary_mint):null;const siteChain=st?.primary_mint&&ports.connection?await Admin.primaryChainStatus(ports.connection,ports.program,st.primary_mint,st.fee_wallet):null;return{...o,site:st,siteToken:meta,siteChain,access:{via:who.via,expiresAt:who.expiresAt||null},passwordSet:(await AdminAuth.state(db)).passwordSet};},
  // Public, chain-derived: a wallet's fixed awards and their payment evidence.
  async 'admin-auth-state'({db}){return AdminAuth.state(db);},
  async 'wallet-rewards'({db,q}){try{W.pk(q.wallet);}catch{fail(400,'INVALID_BODY','Invalid wallet');}
   const rows=(await db.query("SELECT a.cycle_id,a.leaf_index,a.mint,a.amount_lamports,a.state,a.settlement_signature,a.settled_slot,a.receipt_address,c.cycle_number,c.scheduled_end,c.cutoff_time FROM reward_awards a JOIN reward_cycles c ON c.id=a.cycle_id WHERE a.recipient=$1 ORDER BY c.cutoff_time DESC LIMIT 100",[q.wallet])).rows;
   return{wallet:q.wallet,awards:rows};},
  async 'admin-logs'({db,event,q}){
   await adminAccess(db,event);
   const where=[],args=[];const add=(sql,v)=>{args.push(v);where.push(sql.replace('?','$'+args.length));};
   if(q.mint)add('mint=?',q.mint);if(q.cycle)add('cycle_id=?',q.cycle);if(q.severity)add('severity=?',q.severity);if(q.component)add('component=?',q.component);
   if(q.before&&/^\d+$/.test(q.before))add('id<?',q.before);if(q.search)add("safe_message ILIKE '%'||?||'%'",String(q.search).slice(0,80));
   const rows=(await db.query(`SELECT * FROM reward_logs ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id DESC LIMIT 100`,args)).rows;
   return{logs:rows,next:rows.length===100?rows.at(-1).id:null};
  },
  async 'admin-health'({db,event}){
   await adminAccess(db,event);
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
   return planCall(()=>Cycle.submitManualDeposit(chain(db),{mint,intentId:data.intentId,serialized:data.signedTransaction,wallets:s.reboundWallets}));
  },
  // Third-party launch journey (docs/API-V3.md). The browser generates the mint key; the server never sees it.
  async 'launch-draft'({db,event,data}){const s=await Session.authenticate(db,event.headers);
   const args={session:s,wallet:String(data.wallet||''),idempotencyKey:data.idempotencyKey,metadataHash:String(data.metadataHash||''),name:data.name,symbol:data.symbol,initialBuyLamports:/^\d{1,15}$/.test(String(data.initialBuyLamports??'0'))?BigInt(data.initialBuyLamports??0):fail(400,'INVALID_AMOUNT','Invalid initial buy'),namespace:data.namespace==='production'?'production':'mainnet_test'};
   if(await directLaunches(db,args.namespace))return planCall(()=>LaunchDirect.draft(directPorts(db),{...args,quoteMint:data.quoteMint?String(data.quoteMint):null})).then(a=>({attemptId:a.id,state:a.state,settlement:'direct'}));
   return planCall(()=>Launch.draft(launchPorts(db),args)).then(a=>({attemptId:a.id,state:a.state}));},
  async 'launch-prepare'({db,event,data}){const s=await Session.authenticate(db,event.headers);const id=uuid(data.attemptId);
   if(await attemptSettlement(db,id)==='direct')return planCall(()=>LaunchDirect.prepare(directPorts(db),{session:s,attemptId:id,mint:String(data.mint||'')}));
   return planCall(()=>Launch.prepare(launchPorts(db),{session:s,attemptId:id,mint:String(data.mint||'')}));},
  async 'launch-submit'({db,event,data}){const s=await Session.authenticate(db,event.headers);const id=uuid(data.attemptId);
   if(await attemptSettlement(db,id)==='direct')return planCall(()=>LaunchDirect.submit(directPorts(db),{session:s,attemptId:id,signedTransaction:b64tx(data.signedTransaction)}));
   return planCall(()=>Launch.submit(launchPorts(db),{session:s,attemptId:id,index:data.index===1?1:0,signedTransaction:b64tx(data.signedTransaction)}));},
  async 'activation-prepare'({db,event,data}){const s=await Session.authenticate(db,event.headers);return planCall(()=>Launch.activationPrepare(launchPorts(db),{session:s,attemptId:uuid(data.attemptId)}));},
  async 'activation-submit'({db,event,data}){const s=await Session.authenticate(db,event.headers);
   if(!['create_fee_sharing','lock_fee_sharing','activate'].includes(data.step))fail(400,'INVALID_BODY','Unknown setup step');
   return planCall(()=>Launch.activationSubmit(launchPorts(db),{session:s,attemptId:uuid(data.attemptId),step:data.step,signedTransaction:b64tx(data.signedTransaction)}));},
  // Administrator mutations: admin wallet + one-time signed consent for the exact payload.
  ...Object.fromEntries([['admin-set-mode',(db,a,d)=>Admin.setMode(db,a,d)],['admin-test-config',(db,a,d)=>Admin.testConfig(db,a,d)],
   ['admin-pause',(db,a,d)=>Admin.pause(db,a,{...d,paused:true})],['admin-resume',(db,a,d)=>Admin.pause(db,a,{...d,paused:false})],
   ['admin-register-primary',(db,a,d,s)=>Admin.registerPrimary(db,a,s,d)],['admin-opening-credit',(db,a,d)=>Admin.openingCredit(db,a,d)],
   ['admin-site',(db,a,d)=>Admin.setSite(db,a,d)],['admin-launch',(db,a,d,s)=>Admin.launch(db,a,s,d,{connection:rpcConnection(),program:process.env.REWARDS_PROGRAM_ID||null})],
   ['admin-set-wallet',(db,a,d)=>Admin.setAdminWallet(db,a,d)],['admin-key-submit',(db,a,d)=>Inbox.submit(db,a,d)],
   ['admin-add-admin',(db,a,d)=>Admin.addAdmin(db,a,d)],['admin-revoke-admin',(db,a,d)=>Admin.revokeAdmin(db,a,d)]].map(([name,fn])=>[name,async({db,event,data,origin})=>{
   const s=await adminAccess(db,event);const payload=data.payload&&typeof data.payload==='object'?data.payload:{};let actor;
   if(s.via==='password')actor=s.actor;   // password session: the dashboard password is the approval
   else{const wallet=String(data.wallet||'');if(!s.adminWallets.includes(wallet))fail(403,'FORBIDDEN','Approve with your administrator wallet');
    await Consent.consume(db,s,{origin,wallet,action:name,payload,proof:data.proof});actor=wallet;}
   return planCall(()=>fn(db,actor,payload,s));}])),
  // Password access to the dashboard.
  async 'admin-login'({db,event,data}){await Auth.rateLimit(db,'admin-login:'+(event.headers['x-nf-client-connection-ip']||'unknown'),10).catch(e=>fail(429,'RATE_LIMITED',e.message,true));
   const r=await planCall(()=>AdminAuth.login(db,{password:data.password}));await Logs.log(db,{severity:'warn',component:'admin',eventType:'admin_password_login',message:'Admin signed in with the dashboard password'});return r;},
  async 'admin-setup'({db,event,data}){await Auth.rateLimit(db,'admin-login:'+(event.headers['x-nf-client-connection-ip']||'unknown'),10).catch(e=>fail(429,'RATE_LIMITED',e.message,true));
   const r=await planCall(()=>AdminAuth.setup(db,{code:data.code,password:data.password}));await Logs.log(db,{severity:'warn',component:'admin',eventType:'admin_password_created',message:'Admin dashboard password created with the one-time setup code'});return r;},
  async 'admin-password'({db,event,data}){await adminAccess(db,event);
   const r=await planCall(()=>AdminAuth.change(db,{current:data.current,next:data.next}));await Logs.log(db,{severity:'warn',component:'admin',eventType:'admin_password_changed',message:'Admin dashboard password changed; other sessions signed out'});return r;},
  async 'admin-program-prepare'({db,event,data}){const s=await adminAccess(db,event);const wallet=String(data.wallet||'');
   if(!s.adminWallets.includes(wallet))fail(403,'FORBIDDEN','Use your administrator wallet');
   return planCall(()=>Admin.chainPrepare(db,chain(db),{admin:wallet,action:String(data.action||''),params:data.params&&typeof data.params==='object'?data.params:{}}));},
  async 'admin-program-submit'({db,event,data}){const s=await adminAccess(db,event);
   return planCall(()=>Admin.chainSubmit(db,chain(db),s.adminWallets,{intentId:uuid(data.intentId),signedTransaction:b64tx(data.signedTransaction)}));},
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
   return{statusCode:204,headers:{...headersFor(event),'access-control-allow-methods':'GET,POST','access-control-allow-headers':'authorization,content-type,idempotency-key,x-admin-session','access-control-max-age':'600'},body:''};}
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
  const sqlState=typeof error?.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)&&('routine' in error||'severity' in error||'schema' in error);
  if(sqlState&&error.code==='23505')return reply(event,409,{code:'CONFLICT',message:'This conflicts with an existing record. Refresh and review the current state.',retryable:false,requestId});
  const safe=!sqlState&&typeof error?.message==='string'&&error.message.length<200&&!/https?:|postgres|password|secret|key file|ECONN|ENOTFOUND|ENOENT|relation|column|syntax|constraint|duplicate key|permission denied|violates/i.test(error.message);
  if(pool)await Logs.log(pool,{severity:'error',component:'api',eventType:'request_failed',requestId,message:Logs.redactText(error?.message||'error'),errorCode:error?.code||'INTERNAL',metadata:{action}}).catch(()=>{});
  return reply(event,safe?400:503,{code:!sqlState&&error?.code&&/^[A-Z_]+$/.test(error.code)?error.code:safe?'INVALID_REQUEST':'UNAVAILABLE',message:safe?error.message:'This service is temporarily unavailable. Nothing was changed; retry shortly.',retryable:!safe,requestId});
 }
};
exports._internal={handlers,origins,publicConfig,ApiError};
