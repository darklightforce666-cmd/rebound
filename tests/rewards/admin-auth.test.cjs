'use strict';
// Password access to the admin dashboard, exercised with the API's own database role.
const test=require('node:test'),assert=require('node:assert/strict');
const {supabaseDb}=require('./pg.cjs'),AA=require('../../server/rewards/admin-auth.cjs'),A=require('../../server/rewards/admin-v3.cjs');
const env={SUPABASE_SECRET_KEY:'test-session-seed'};
async function asApi(db,fn){await db.query('SET ROLE rebound_api');try{return await fn();}finally{await db.query('RESET ROLE');}}

test('scrypt hashes verify only the right password',()=>{
 const h=AA.hashPassword('correct horse battery');assert.match(h,/^scrypt\$/);
 assert.equal(AA.verifyPassword('correct horse battery',h),true);assert.equal(AA.verifyPassword('wrong',h),false);assert.equal(AA.verifyPassword('x','garbage'),false);
});

test('setup code → password → login → session; wrong attempts lock; password change signs other sessions out',async()=>{
 const db=await supabaseDb();try{
  const opts={env};
  assert.deepEqual(await asApi(db,()=>AA.state(db)),{passwordSet:false,setupOpen:false});
  await assert.rejects(asApi(db,()=>AA.login(db,{password:'whatever1234'},opts)),e=>e.code==='SETUP_REQUIRED');
  const code='one-time-code-123456';await db.query("UPDATE reward_admin_auth SET setup_hash=$1,setup_expires=now()+interval '1 day'",[AA.sha256(code)]);   // operator issues the code
  assert.equal((await asApi(db,()=>AA.state(db))).setupOpen,true);
  await assert.rejects(asApi(db,()=>AA.setup(db,{code:'nope',password:'long enough password'},opts)),e=>e.code==='WRONG_CODE');
  await assert.rejects(asApi(db,()=>AA.setup(db,{code,password:'short'},opts)),e=>e.code==='WEAK_PASSWORD');
  const first=await asApi(db,()=>AA.setup(db,{code,password:'first password!'},opts));
  await assert.rejects(asApi(db,()=>AA.setup(db,{code,password:'another password'},opts)),e=>e.code==='ALREADY_SET');   // the code dies on use
  const s1=await asApi(db,()=>AA.session(db,{'x-admin-session':first.token},opts));assert.equal(s1.via,'password');
  assert.equal(await asApi(db,()=>AA.session(db,{'x-admin-session':first.token.replace(/.$/,c=>c==='A'?'B':'A')},opts)),null,'tampered token');
  assert.equal(await asApi(db,()=>AA.session(db,{'x-admin-session':first.token},{env:{SUPABASE_SECRET_KEY:'other'}})),null,'other key');
  for(let i=0;i<5;i++)await assert.rejects(asApi(db,()=>AA.login(db,{password:'bad'},opts)),e=>e.code==='WRONG_PASSWORD');
  await assert.rejects(asApi(db,()=>AA.login(db,{password:'first password!'},opts)),e=>e.code==='LOCKED');
  await db.query('UPDATE reward_admin_auth SET locked_until=now()-interval \'1 second\'');
  const second=await asApi(db,()=>AA.login(db,{password:'first password!'},opts));assert.ok(second.token);
  await assert.rejects(asApi(db,()=>AA.change(db,{current:'wrong',next:'new password here'},opts)),e=>e.code==='WRONG_PASSWORD');
  const third=await asApi(db,()=>AA.change(db,{current:'first password!',next:'new password here'},opts));
  assert.equal(await asApi(db,()=>AA.session(db,{'x-admin-session':second.token},opts)),null,'old sessions are signed out');
  assert.ok(await asApi(db,()=>AA.session(db,{'x-admin-session':third.token},opts)));
  assert.ok(await asApi(db,()=>AA.login(db,{password:'new password here'},opts)));
  await db.query('SET ROLE anon');try{await assert.rejects(db.query('SELECT * FROM rebound.reward_admin_auth'),/permission denied/);}finally{await db.query('RESET ROLE');}
 }finally{await db.close();}
});

test('set admin wallet replaces the previous one',async()=>{
 const db=await supabaseDb();try{
  const {Keypair}=require('@solana/web3.js');const a=Keypair.generate().publicKey.toBase58(),b=Keypair.generate().publicKey.toBase58();
  await asApi(db,()=>A.setAdminWallet(db,'admin (password)',{wallet:a}));await asApi(db,()=>A.setAdminWallet(db,'admin (password)',{wallet:b}));
  assert.deepEqual((await db.query('SELECT wallet FROM reward_admin_wallets WHERE revoked_at IS NULL')).rows.map(r=>r.wallet),[b]);
  await asApi(db,()=>A.setAdminWallet(db,'admin (password)',{wallet:a}));
  assert.deepEqual((await db.query('SELECT wallet FROM reward_admin_wallets WHERE revoked_at IS NULL')).rows.map(r=>r.wallet),[a]);
  await assert.rejects(asApi(db,()=>A.setAdminWallet(db,'x',{wallet:'nope'})),e=>e.code==='INVALID_BODY');
 }finally{await db.close();}
});

test('API: a password session opens the dashboard and approves changes without a wallet; no session is refused',async()=>{
 const db=await supabaseDb();const saved={...process.env};Object.assign(process.env,env,{SUPABASE_URL:'https://example.invalid',SUPABASE_PUBLISHABLE_KEY:'k'});try{
  const F=require('../../netlify/functions/rewards.cjs'),H=F._internal.handlers;
  await db.query("UPDATE reward_admin_auth SET setup_hash=$1,setup_expires=now()+interval '1 day'",[AA.sha256('code-abcdef-123')]);
  const {token}=await H.POST['admin-setup']({db,event:{headers:{}},data:{code:'code-abcdef-123',password:'dashboard password'}});
  const ev={headers:{'x-admin-session':token}};
  const o=await H.GET['admin-overview']({db,event:ev});assert.equal(o.access.via,'password');assert.equal(o.passwordSet,true);
  const st=await H.POST['admin-site']({db,event:ev,data:{payload:{open:true}},origin:'https://rebound.wtf'});assert.equal(st.site_open,true);
  const {Keypair}=require('@solana/web3.js'),w=Keypair.generate().publicKey.toBase58();
  await H.POST['admin-set-wallet']({db,event:ev,data:{payload:{wallet:w}},origin:'https://rebound.wtf'});
  assert.deepEqual((await db.query('SELECT wallet FROM reward_admin_wallets WHERE revoked_at IS NULL')).rows.map(r=>r.wallet),[w]);
  assert.ok((await db.query("SELECT 1 FROM reward_audit WHERE kind='admin_site' AND actor='admin (password)'")).rows.length);
  await assert.rejects(H.POST['admin-site']({db,event:{headers:{}},data:{payload:{open:false}},origin:'https://rebound.wtf'}));                       // no session at all
  await assert.rejects(H.POST['admin-site']({db,event:{headers:{'x-admin-session':token+'x'}},data:{payload:{open:false}},origin:'https://rebound.wtf'}));   // forged
  assert.equal((await db.query('SELECT site_open FROM reward_site')).rows[0].site_open,true);
  await assert.rejects(H.POST['admin-login']({db,event:{headers:{}},data:{password:'nope'}}),e=>e.status===401);
 }finally{process.env=saved;await db.close();}
});
