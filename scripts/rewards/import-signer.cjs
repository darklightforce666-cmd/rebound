#!/usr/bin/env node
'use strict';
// One-time operator import of the automatic primary dev-wallet signer (spec §11.2).
// Run ON THE SCHEDULER HOST (it needs REWARDS_SIGNER_MASTER_KEY_FILE and SCHEDULER_DATABASE_URL).
// The secret is read from a file or stdin — never from command-line arguments or env — and is
// never printed. Output: key id, public address and readiness only.
//
//   node scripts/rewards/import-signer.cjs --role primary_dev --expect <DEV_WALLET_ADDRESS> --file /path/key.json
//   … --file -          (read from stdin, e.g. a password manager pipe)
// Then connect it in the admin panel ("automatic mode") or:
//   UPDATE rebound.reward_funding_wallets SET mode='automatic', signer='<id>' WHERE address='<DEV_WALLET_ADDRESS>';
const fs=require('node:fs');
const DB=require('../../server/rewards/db.cjs'),S=require('../../server/rewards/signer.cjs');
const arg=n=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:null;};
(async()=>{
 const role=arg('role')||'primary_dev',expect=arg('expect'),file=arg('file');
 if(!expect||!file)throw Object.assign(Error('--expect <address> and --file <path|-> are required'),{code:'USAGE'});
 let text=file==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(file,'utf8');
 const db=DB.connect(process.env.SCHEDULER_DATABASE_URL||process.env.DATABASE_URL,{max:1,name:'rebound-import-signer'});
 try{const r=await S.importSigner(db,{role,secretText:text,expectedAddress:expect});process.stdout.write(JSON.stringify(r)+'\n');}
 finally{text=null;await db.end();}
})().catch(e=>{process.stderr.write('import failed: '+(e.code||'ERROR')+' '+String(e.message).replace(/[1-9A-HJ-NP-Za-km-z]{80,}/g,'[redacted]')+'\n');process.exitCode=1;});
