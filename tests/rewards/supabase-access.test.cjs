'use strict';
// M1 acceptance: authentication, roles, RLS and private/public boundaries (spec §12, §14, §15, §19).
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Keypair}=require('@solana/web3.js');
const {supabaseDb,as,asCommit,user}=require('./pg.cjs');
const DB=require('../../server/rewards/db.cjs'),Session=require('../../server/rewards/session.cjs'),Consent=require('../../server/rewards/consent.cjs');
const Logs=require('../../server/rewards/logs.cjs'),Metadata=require('../../server/rewards/metadata.cjs'),S=require('../../server/rewards/storage.cjs');
const wallet=()=>Keypair.generate();
function signWith(key,text){const pk=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(key.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});return crypto.sign(null,Buffer.from(text),pk).toString('base64');}
const PUBLIC_TABLES=['reward_public_tokens','reward_public_cycles'];

async function tables(db){return(await db.query("SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rebound' AND c.relkind='r' ORDER BY 1")).rows;}
async function seedLog(db,message='cycle 1 snapshot stored'){await Logs.log(db,{severity:'info',component:'scheduler',eventType:'snapshot',message});}

test('every REBOUND table has RLS enabled and lives outside the exposed public schema',async()=>{
 const db=await supabaseDb();try{
  const all=await tables(db);assert.ok(all.length>=58);
  assert.deepEqual(all.filter(t=>!t.relrowsecurity).map(t=>t.relname),[]);
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'reward_%'")).rows[0].n,0);
 }finally{await db.close();}
});

test('anonymous clients read only sanitized projections and can write nothing',async()=>{
 const db=await supabaseDb();try{
  await db.query("INSERT INTO reward_public_tokens(mint,namespace,kind,name,reward_status) VALUES('M1','production','third_party','Coin','active')");
  await seedLog(db);
  for(const t of await tables(db)){
   await as(db,'anon',null,async()=>{
    if(PUBLIC_TABLES.includes(t.relname))assert.ok((await db.query(`SELECT * FROM rebound.${t.relname}`)).rows.length>=0);
    else await assert.rejects(db.query(`SELECT 1 FROM rebound.${t.relname} LIMIT 1`),/permission denied/,t.relname);
   });
   await as(db,'anon',null,()=>assert.rejects(db.query(`INSERT INTO rebound.${t.relname} DEFAULT VALUES`),/permission denied/,t.relname));
   await as(db,'authenticated',{sub:crypto.randomUUID(),role:'authenticated'},()=>assert.rejects(db.query(`DELETE FROM rebound.${t.relname}`),/permission denied/,t.relname));
  }
  await as(db,'anon',null,async()=>assert.equal((await db.query('SELECT name FROM rebound.reward_public_tokens')).rows[0].name,'Coin'));
  await as(db,'anon',null,()=>assert.rejects(db.query("UPDATE rebound.reward_public_tokens SET name='x'"),/permission denied/));
 }finally{await db.close();}
});

test('admin logs: only verified admin wallets signed in on a REBOUND domain can read them; metadata flags are ignored',async()=>{
 const db=await supabaseDb();try{
  await seedLog(db);
  const admin=wallet().publicKey.toBase58(),other=wallet().publicKey.toBase58();
  await db.query("INSERT INTO reward_admin_wallets(wallet,label,added_by) VALUES($1,'owner','bootstrap')",[admin]);
  const a=await user(db,{wallet:admin}),forged=await user(db,{wallet:other,metadata:{isAdmin:true,role:'admin'}});
  const foreign=await user(db,{wallet:admin,domain:'pokedrop.cards'}).catch(()=>null); // same provider_id cannot exist twice
  assert.equal(foreign,null);
  const count=claims=>as(db,'authenticated',claims,async()=>(await db.query('SELECT count(*)::int n FROM rebound.reward_logs')).rows[0].n);
  assert.equal(await count(a.claims),1);
  assert.equal(await count(forged.claims),0);
  assert.equal(await count({...forged.claims,role:'admin',app_metadata:{role:'admin'}}),0);
  // Admin wallet whose latest sign-in was on another site does not get REBOUND admin reads.
  await db.query("UPDATE auth.identities SET identity_data=jsonb_set(identity_data,'{custom_claims,domain}','\"pokedrop.cards\"') WHERE provider_id=$1",['web3:solana:'+admin]);
  assert.equal(await count(a.claims),0);
  await db.query("UPDATE auth.identities SET identity_data=jsonb_set(identity_data,'{custom_claims,domain}','\"rebound.wtf\"') WHERE provider_id=$1",['web3:solana:'+admin]);
  await db.query('UPDATE reward_admin_wallets SET revoked_at=now(),revoked_by=$2 WHERE wallet=$1',[admin,'test']);
  assert.equal(await count(a.claims),0);
  await as(db,'anon',null,()=>assert.rejects(db.query('SELECT rebound.reward_is_admin()'),/permission denied/));
 }finally{await db.close();}
});

test('creators see only their own launch drafts; two creators cannot read each other',async()=>{
 const db=await supabaseDb();try{
  const one=await user(db,{wallet:wallet().publicKey.toBase58()}),two=await user(db,{wallet:wallet().publicKey.toBase58()});
  for(const [u,name] of [[one,'One'],[two,'Two']])await db.query("INSERT INTO reward_launch_attempts(id,wallet,state,request_hash,metadata_uri,metadata_hash,user_id,name) VALUES($1,'w','draft',$2,'u','h',$3,$4)",[crypto.randomUUID(),crypto.randomUUID(),u.id,name]);
  const names=claims=>as(db,'authenticated',claims,async()=>(await db.query('SELECT name FROM rebound.reward_launch_attempts')).rows.map(r=>r.name));
  assert.deepEqual(await names(one.claims),['One']);assert.deepEqual(await names(two.claims),['Two']);
  await as(db,'authenticated',one.claims,()=>assert.rejects(db.query("UPDATE rebound.reward_launch_attempts SET name='x'"),/permission denied/));
  await as(db,'authenticated',one.claims,()=>assert.rejects(db.query('SELECT evidence FROM rebound.reward_launch_attempts'),/permission denied/));
 }finally{await db.close();}
});

test('runtime roles are least-privilege: no role reads keys except the scheduler, none rewrites evidence',async()=>{
 const db=await supabaseDb();try{
  for(const role of ['rebound_api','rebound_indexer','rebound_verifier'])await as(db,role,null,()=>assert.rejects(db.query('SELECT ciphertext FROM rebound.reward_signers'),/permission denied/,role));
  await as(db,'rebound_scheduler',null,async()=>assert.ok(Array.isArray((await db.query('SELECT ciphertext FROM rebound.reward_signers')).rows)));
  await as(db,'rebound_api',null,()=>assert.rejects(db.query("INSERT INTO rebound.reward_funding_accounts(mint,kind) VALUES('m','primary')"),/permission denied/));
  await as(db,'rebound_api',null,()=>assert.rejects(db.query("UPDATE rebound.reward_policies SET canonical='x'"),/permission denied/));
  await as(db,'rebound_indexer',null,()=>assert.rejects(db.query("UPDATE rebound.reward_cycles SET state='complete'"),/permission denied/));
  await as(db,'rebound_verifier',null,()=>assert.rejects(db.query("INSERT INTO rebound.reward_awards(cycle_id,leaf_index,mint,recipient,amount_lamports,credit_usd,lot_credits,state) VALUES('c',0,'m','r',1,1,'[]','planned')"),/permission denied/));
  await asCommit(db,'rebound_api',()=>seedLog(db,'api wrote a log'));
  await assert.rejects(db.query("UPDATE reward_logs SET safe_message='rewritten'"),/immutable/);
  await assert.rejects(db.query('DELETE FROM reward_logs'),/immutable/);
 }finally{await db.close();}
});

test('Supabase session verification uses only server-controlled identity fields',async()=>{
 const db=await supabaseDb();try{
  const admin=wallet().publicKey.toBase58();await db.query("INSERT INTO reward_admin_wallets(wallet,label,added_by) VALUES($1,'owner','bootstrap')",[admin]);
  const cfg={url:'https://abcdefghijklmnop.supabase.co',publishableKey:'sb_publishable_'+'x'.repeat(30),configured:true};
  const identity=(w,domain)=>({provider:'web3',id:'web3:solana:'+w,provider_id:'web3:solana:'+w,identity_data:{custom_claims:{domain}}});
  const fake=user=>async(url,init)=>{assert.equal(url,cfg.url+'/auth/v1/user');assert.equal(init.headers.apikey,cfg.publishableKey);return{ok:!!user,status:user?200:401,json:async()=>user};};
  const ok=await Session.authenticate(db,{authorization:'Bearer '+'a'.repeat(40)},{need:'admin',cfg,fetchImpl:fake({id:crypto.randomUUID(),identities:[identity(admin,'rebound.wtf')]})});
  assert.equal(ok.admin,true);assert.deepEqual(ok.adminWallets,[admin]);
  await assert.rejects(Session.authenticate(db,{authorization:'Bearer '+'a'.repeat(40)},{need:'admin',cfg,fetchImpl:fake({id:crypto.randomUUID(),user_metadata:{isAdmin:true},app_metadata:{role:'admin'},identities:[identity(wallet().publicKey.toBase58(),'rebound.wtf')]})}),e=>e.code==='FORBIDDEN');
  await assert.rejects(Session.authenticate(db,{authorization:'Bearer '+'a'.repeat(40)},{need:'admin',cfg,fetchImpl:fake({id:crypto.randomUUID(),identities:[identity(admin,'pokedrop.cards')]})}),e=>e.code==='FORBIDDEN');
  await assert.rejects(Session.authenticate(db,{},{cfg,fetchImpl:fake(null)}),e=>e.code==='UNAUTHORIZED');
  await assert.rejects(Session.authenticate(db,{authorization:'Bearer '+'a'.repeat(40)},{cfg,fetchImpl:fake(null)}),e=>e.code==='UNAUTHORIZED');
  await assert.rejects(Session.authenticate(db,{authorization:'Bearer x'},{cfg:{...cfg,configured:false}}),e=>e.code==='AUTH_UNAVAILABLE');
 }finally{await db.close();}
});

test('one-time consent binds user, wallet, domain, action and payload; replay and substitution fail',async()=>{
 const db=await supabaseDb();try{
  const key=wallet(),w=key.publicKey.toBase58();
  const session={userId:crypto.randomUUID(),reboundWallets:[w],wallets:[w]},origin='https://rebound.wtf';
  const payload={mint:'So11111111111111111111111111111111111111112'};
  const c=await Consent.challenge(db,session,{origin,wallet:w,action:'admin-pause',payload,binding:{policy:'abc'}});
  assert.match(c.message,/^rebound\.wtf wants you to approve one REBOUND action/);assert.match(c.message,/does not send a transaction, move SOL or tokens, or authorize future spending/);
  const sign=text=>signWith(key,text);
  const proof={id:c.id,signature:sign(c.message)};
  await assert.rejects(Consent.consume(db,session,{origin,wallet:w,action:'admin-pause',payload:{mint:'other'},proof}),/Invalid or expired/);
  await assert.rejects(Consent.consume(db,session,{origin,wallet:w,action:'admin-resume',payload,proof}),/Invalid or expired/);
  await assert.rejects(Consent.consume(db,session,{origin:'https://evil.example',wallet:w,action:'admin-pause',payload,proof}),/Invalid or expired/);
  await assert.rejects(Consent.consume(db,{...session,userId:crypto.randomUUID()},{origin,wallet:w,action:'admin-pause',payload,proof}),/Invalid or expired/);
  await assert.rejects(Consent.consume(db,session,{origin,wallet:w,action:'admin-pause',payload,proof:{id:c.id,signature:sign(c.message+'x')}}),/Invalid or expired/);
  assert.equal((await Consent.consume(db,session,{origin,wallet:w,action:'admin-pause',payload,proof})).wallet,w);
  await assert.rejects(Consent.consume(db,session,{origin,wallet:w,action:'admin-pause',payload,proof}),/Invalid or expired/);
  await assert.rejects(Consent.challenge(db,{...session,reboundWallets:[]},{origin,wallet:w,action:'admin-pause',payload}),/Sign in with this wallet/);
 }finally{await db.close();}
});

test('durable row leases exclude concurrent owners, expire after crashes and fence stale owners',async()=>{
 const db=await supabaseDb();try{
  const a=await DB.acquireLease(db,'cycle:m:1','worker-a',30);assert.equal(a,1n);
  assert.equal(await DB.acquireLease(db,'cycle:m:1','worker-b',30),null);
  await db.query("UPDATE reward_leases SET lease_until=now()-interval '1 second'");         // worker-a crashed
  const b=await DB.acquireLease(db,'cycle:m:1','worker-b',30);assert.equal(b,2n);
  assert.equal(await DB.renewLease(db,'cycle:m:1','worker-a',a,30),false);                  // stale owner fenced
  assert.equal(await DB.renewLease(db,'cycle:m:1','worker-b',b,30),true);
  assert.equal(await DB.withLease(db,'cycle:m:1','worker-c',async()=>'ran',{busy:()=>'busy'}),'busy');
  await DB.releaseLease(db,'cycle:m:1','worker-b',b);
  assert.equal(await DB.withLease(db,'cycle:m:1','worker-c',async()=>'ran'),'ran');
 }finally{await db.close();}
});

test('logs never persist secrets, credential URLs, tokens or key bytes',async()=>{
 const db=await supabaseDb();try{
  const secret=Keypair.generate(),bs58=require('bs58');
  await Logs.log(db,{severity:'error',component:'worker',eventType:'rpc_failed',
   message:'failed https://mainnet.helius-rpc.com/?api-key=abc123 postgres://u:p@h/db eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2lnbg sb_secret_abcdef '+bs58.encode(Buffer.from(secret.secretKey)),
   metadata:{privateKey:'x',nested:{seed:'y',rpc:'https://x.quiknode.pro/token/'},bytes:JSON.stringify([...secret.secretKey]),apikey:'k'}});
  const row=(await db.query('SELECT safe_message,safe_metadata::text m FROM reward_logs')).rows[0],all=row.safe_message+row.m;
  for(const leak of ['abc123','u:p@h','eyJhbGci','sb_secret_abcdef',bs58.encode(Buffer.from(secret.secretKey)),'quiknode','"x"','"y"','"k"',String(secret.secretKey[0])+','+String(secret.secretKey[1])+','])assert.ok(!all.includes(leak),leak);
  assert.equal(Logs.redactText('Cycle 3 paid 12 recipients and retained the fifteen percent share on the dev wallet as configured'),'Cycle 3 paid 12 recipients and retained the fifteen percent share on the dev wallet as configured');
 }finally{await db.close();}
});

test('metadata uploads are validated, content-addressed and never overwrite a different object',async()=>{
 const db=await supabaseDb();try{
  const cfg={url:'https://abcdefghijklmnop.supabase.co',key:'sb_secret_test',configured:true},store=new Map(),calls=[];
  const fetchImpl=async(url,init={})=>{calls.push([init.method||'GET',url,init.headers?.['x-upsert']]);
   if(init.method==='POST'){const p=url.split('/storage/v1/object/')[1];if(store.has(p))return{ok:false,status:409};store.set(p,Buffer.from(init.body));return{ok:true,status:200};}
   const p=url.split('/storage/v1/object/public/')[1];return store.has(p)?{ok:true,status:200,arrayBuffer:async()=>store.get(p)}:{ok:false,status:404};};
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),crypto.randomBytes(64)]).toString('base64');
  const input={name:'Rebound Test',symbol:'RBT',description:'test',imageBase64:png,website:'https://rebound.wtf',twitter:'https://x.com/rebound'};
  const a=await Metadata.upload(db,{...input,cfg},fetchImpl),b=await Metadata.upload(db,{...input,cfg},fetchImpl);
  assert.equal(a.uri,b.uri);assert.match(a.uri,/^https:\/\/abcdefghijklmnop\.supabase\.co\/storage\/v1\/object\/public\/rebound-token-assets\/metadata\/[a-f0-9]{64}\.json$/);
  assert.ok(a.uri.length<=200);assert.ok(calls.filter(c=>c[0]==='POST').every(c=>c[2]==='false'));
  assert.equal(a.data.image.split('/').at(-1).length,64+4);
  assert.equal((await db.query("SELECT count(*)::int n FROM reward_assets")).rows[0].n,2);
  store.set('rebound-token-assets/'+a.uri.split('/rebound-token-assets/')[1],Buffer.from('{"tampered":true}'));
  await assert.rejects(Metadata.upload(db,{...input,cfg},fetchImpl),/conflict/);
  for(const bad of [{name:''},{name:'x'.repeat(33)},{symbol:'TOOLONGTICKER'},{imageBase64:Buffer.from('GIF89a'+'x'.repeat(40)).toString('base64')},{website:'http://insecure.example'},{twitter:'https://evil.example/x.com'}])
   assert.throws(()=>Metadata.validate({...input,...bad}));
  await assert.rejects(Metadata.upload(db,{...input,cfg:{...cfg,configured:false}},fetchImpl),/not configured/);
 }finally{await db.close();}
});
