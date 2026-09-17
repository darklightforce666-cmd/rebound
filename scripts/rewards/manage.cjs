'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{Connection}=require('@solana/web3.js');
const DB=require('../../server/rewards/db.cjs'),C=require('../../server/rewards/config.cjs'),P=require('../../server/rewards/policy.cjs'),S=require('../../server/rewards/snapshot.cjs'),V=require('../../server/rewards/verifier.cjs');
async function main(){const command=process.argv[2],cfg=C.settings();
 if(command==='policy'){console.log(P.stable({policy:P.POLICY,hash:P.POLICY_HASH}));return;}
 if(command==='preflight'){
  const blockers=C.configurationBlockers(cfg);if(!process.env.DATABASE_URL)blockers.push('DATABASE_URL not configured');
  if(blockers.length){console.log(P.stable({mode:cfg.mode,ready:false,blockers}));process.exitCode=2;return;}
 }
 if(command==='dry-run'&&process.argv.includes('--fixtures')){const {replay}=require('../../tests/rewards/replay.test.cjs'),R=require('../../server/rewards/receipts.cjs'),p=replay(),ledger=R.attribute(p,p.events);console.log(P.stable({mode:'dry-run',classification:'captured-real-SBF-execution-with-synthetic-local-trades',qualifyingLots:p.lots,heldPurchases:p.holds,creatorFeeReceipts:ledger.receipts,transfers:0}));return;}
 const db=DB.connect();try{
  if(command==='migrate'){await DB.migrate(db);console.log('Rewards database migrations applied.');return;}
  if(command==='register-deployment'){for(const k of ['program','operations','publisher','verifier','guardian'])if(!cfg[k])throw Error(k+' is required');if(!process.env.REWARDS_GOVERNANCE_ADDRESS)throw Error('Governance public address required');await db.query('INSERT INTO reward_deployments(id,program,genesis,policy_hash,operations,publisher,verifier,guardian,upgrade_authority) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[cfg.program,cfg.genesis,cfg.policy,cfg.operations,cfg.publisher,cfg.verifier,cfg.guardian,process.env.REWARDS_GOVERNANCE_ADDRESS]);console.log('Deployment registered with payments disabled.');return;}
  const connection=new Connection(cfg.rpc,'finalized');
  if(command==='preflight'){const r=await C.preflight(connection,db,cfg);console.log(P.stable({mode:cfg.mode,...r}));if(!r.ready)process.exitCode=2;return;}
  if(command==='dry-run'){const mint=process.argv[3];if(!mint)throw Error('Supply the enrolled mint public address');const cutoff=await S.finalizedCutoff(db,connection),snapshot=await S.snapshot(db,connection,{mint,cutoff,program:cfg.program});const result=snapshot.complete?V.manifestFor(snapshot,cfg.program,Math.floor(cutoff.time/1800)):snapshot;console.log(P.stable({mode:'dry-run',transfers:0,result}));return;}
  if(command==='export-audit'){const mint=process.argv[3],out=process.argv[4];if(!mint||!out)throw Error('Supply mint and output path');const result={mint,policy:P.POLICY_HASH};for(const table of ['reward_coins','reward_events','reward_purchase_lots','reward_disqualifications','reward_wallet_links','reward_receipts','reward_journal','reward_rounds','reward_allocations','reward_audit'])result[table]=(await db.query('SELECT * FROM '+table+' WHERE mint=$1',[mint])).rows;await fs.writeFile(path.resolve(out),P.stable(result),{flag:'wx'});console.log('Public audit evidence exported.');return;}
  throw Error('Commands: migrate, policy, register-deployment, preflight, dry-run [mint|--fixtures], export-audit mint output.json');
 }finally{await db.end();}}
main().catch(e=>{console.error(e.message.replace(/https?:\/\/\S+/g,'[endpoint]'));process.exitCode=1;});
