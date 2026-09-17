'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process'),{Keypair}=require('@solana/web3.js');
const C=require('../../server/rewards/config.cjs');
function configured(){const cfg=C.settings({SOLANA_RPC_URL:'https://rpc.example.test',HISTORY_RPC_URL:'https://history.example.test',REWARDS_ACTIVATION_JSON:'{}'});for(const key of ['program','operations','publisher','verifier','guardian','governance','deliveryPayer','claimPayer'])cfg[key]=Keypair.generate().publicKey.toBase58();return cfg;}
test('configuration rejects missing roles, invalid endpoints and shared signer roles without network access',async()=>{
 const cfg=configured();assert.deepEqual(C.configurationBlockers(cfg),[]);
 assert.equal(cfg.enabled,false);assert.equal(C.settings({REWARDS_TRANSFERS_ENABLED:'TRUE'}).enabled,false);
 for(const name of ['program','governance','deliveryPayer','claimPayer'])assert.ok(C.configurationBlockers({...cfg,[name]:null}).includes(name+' not configured'));
 assert.match(C.configurationBlockers({...cfg,verifier:cfg.publisher}).join(';'),/separate address/);
 assert.match(C.configurationBlockers({...cfg,rpc:'http://rpc.example.test/private-key'}).join(';'),/HTTPS endpoint/);
 const report=await C.preflight(null,null,C.settings({}));assert.equal(report.ready,false);assert.ok(report.blockers.includes('program not configured'));
 assert.throws(()=>C.requireProduction({ready:true},cfg),/Transfers disabled/);
});
test('every signer file must match its explicit expected public key',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rebound-signer-test-')),file=path.join(dir,'fixture.json'),key=Keypair.generate(),envName='REBOUND_TEST_SIGNER_FILE',prior=process.env[envName];
 try{await fs.writeFile(file,JSON.stringify([...key.secretKey]),{mode:0o600});process.env[envName]=file;
  assert.equal((await C.keyFromFile(envName,key.publicKey.toBase58())).publicKey.toBase58(),key.publicKey.toBase58());
  await assert.rejects(C.keyFromFile(envName,Keypair.generate().publicKey.toBase58()),/public key mismatch/);
  await assert.rejects(C.keyFromFile(envName),/Expected signer public address/);
 }finally{if(prior===undefined)delete process.env[envName];else process.env[envName]=prior;await fs.unlink(file);await fs.rmdir(dir);}
});
test('Netlify cold start works when synchronous require of ES modules is disabled',()=>{
 const result=spawnSync(process.execPath,['--no-experimental-require-module',path.resolve(__dirname,'../../scripts/check-functions.cjs')],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
 assert.match(result.stdout,/All function modules load/);
});
test('preflight with empty configuration reports blockers without opening a database or RPC',()=>{
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('REWARDS_')||['DATABASE_URL','SOLANA_RPC_URL','HISTORY_RPC_URL'].includes(key))delete env[key];
 const result=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/rewards/manage.cjs'),'preflight'],{encoding:'utf8',env,timeout:30000});
 assert.equal(result.status,2,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.ready,false);assert.ok(report.blockers.includes('DATABASE_URL not configured'));assert.ok(report.blockers.includes('rpc not configured'));
});
