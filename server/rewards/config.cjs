'use strict';
const fs=require('node:fs/promises');
const {Keypair,Connection}=require('@solana/web3.js');
const W=require('./wire.cjs'),P=require('./policy.cjs');
const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
function settings(env=process.env){
 const enabled=env.REWARDS_TRANSFERS_ENABLED==='true';
 return{enabled,mode:enabled?'production':'dry-run',program:env.REWARDS_PROGRAM_ID||null,operations:env.REWARDS_OPERATIONS_ADDRESS||null,publisher:env.REWARDS_PUBLISHER_ADDRESS||null,verifier:env.REWARDS_VERIFIER_ADDRESS||null,guardian:env.REWARDS_GUARDIAN_ADDRESS||null,genesis:env.REWARDS_GENESIS_HASH||MAINNET_GENESIS,policy:P.POLICY_HASH,origin:env.PUBLIC_SITE_ORIGIN||'https://reboundpad.fun',rpc:env.SOLANA_RPC_URL,historyRpc:env.HISTORY_RPC_URL,activationFile:env.REWARDS_ACTIVATION_FILE,activationJson:env.REWARDS_ACTIVATION_JSON};
}
async function keyFromFile(envName,expected){const file=process.env[envName];if(!file)throw Error(envName+' is not configured');const raw=JSON.parse(await fs.readFile(file,'utf8'));if(!Array.isArray(raw)||raw.length!==64||raw.some(n=>!Number.isInteger(n)||n<0||n>255))throw Error('Invalid signer file');const key=Keypair.fromSecretKey(Uint8Array.from(raw));if(expected&&!key.publicKey.equals(W.pk(expected)))throw Error('Configured signer public key mismatch');return key;}
async function preflight(connection,db,cfg=settings()){
 const blockers=[];for(const k of ['program','operations','publisher','verifier','guardian','rpc','historyRpc'])if(!cfg[k])blockers.push(k+' not configured');
 if(!cfg.activationFile&&!cfg.activationJson)blockers.push('Activation evidence not configured');
 if(blockers.length)return{ready:false,blockers};
 try{
  if(await connection.getGenesisHash()!==cfg.genesis)throw Error('Wrong Solana network');
  const deployment=W.pda(cfg.program,'deployment-v2'),result=await connection.getAccountInfoAndContext(deployment,'finalized');
  if(!result.value?.owner.equals(W.pk(cfg.program)))throw Error('Deployment not initialized by this program');const d=W.decode(result.value.data,'deployment');
  for(const key of ['operations','publisher','verifier','guardian'])if(d[key]!==cfg[key])throw Error(key+' authority mismatch');if(d.policy!==cfg.policy||d.paused)throw Error('Deployment paused or policy mismatch');
  const program=await connection.getAccountInfo(W.pk(cfg.program),'finalized'),loader=W.pk('BPFLoaderUpgradeab1e11111111111111111111111');
  if(!program?.executable||!program.owner.equals(loader)||program.data.length!==36)throw Error('Invalid upgradeable program');
  const programData=W.pk(program.data.subarray(4,36)),pd=await connection.getAccountInfo(programData,'finalized');if(!pd||pd.data[12]!==1)throw Error('Expected retained governed upgrade authority');
  const upgrade=W.pk(pd.data.subarray(13,45)).toBase58(),activation=JSON.parse(cfg.activationJson||await fs.readFile(cfg.activationFile,'utf8'));
  const digest=W.hash(pd.data.subarray(45)).toString('hex');
  if(activation.program!==cfg.program||activation.genesis!==cfg.genesis||activation.policy!==cfg.policy||activation.binarySha256!==digest||activation.upgradeAuthority!==upgrade)throw Error('Activation evidence does not match deployed bytes');
  for(const name of ['pumpCurveLifecycle','pumpGraduatedLifecycle','receiptAttribution','historicalReplay','adversarialProgramTests','independentSecurityReview','fundingCalibration','governanceTimelock'])if(!activation.checks?.[name]?.passed||!activation.checks[name].evidence)blockers.push('Unverified production check: '+name);
  const database=(await db.query('SELECT * FROM reward_deployments WHERE program=$1',[cfg.program])).rows[0];if(!database||database.policy_hash!==cfg.policy||!database.enabled)blockers.push('Deployment not enabled in database');
  for(const[table,privilege]of [['reward_deployments','UPDATE'],['reward_link_corrections','INSERT'],['reward_raw_blocks','UPDATE'],['reward_services','UPDATE']])if((await db.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed',[table,privilege])).rows[0].allowed)blockers.push('Runtime database role is overprivileged: '+table);
  if(upgrade!==d.admin)blockers.push('Upgrade authority and administered governance differ');
  return{ready:!blockers.length,blockers,deployment:d,slot:result.context.slot,binarySha256:digest};
 }catch(e){return{ready:false,blockers:[...blockers,e.message]};}
}
function requireProduction(result,cfg=settings()){if(!cfg.enabled||!result.ready)throw Error('Transfers disabled: '+(result.blockers||[]).join('; '));}
module.exports={MAINNET_GENESIS,settings,keyFromFile,preflight,requireProduction};
