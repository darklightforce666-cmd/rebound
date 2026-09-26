#!/usr/bin/env node
'use strict';
// Create (or rotate) a scoped Supabase Postgres login WITHOUT the password ever leaving this host.
// A random password is generated here and written only into a mode-600 file holding the full
// connection URL; what is printed is SQL carrying the SCRAM-SHA-256 verifier (not the password) to
// paste into the Supabase SQL editor (or apply through the Supabase MCP/CLI).
//
//   node scripts/rewards/db-login.cjs --role scheduler --out ./runtime-secrets \
//        [--host aws-0-eu-central-1.pooler.supabase.com] [--port 5432] [--project zuvefozubbgstyljfxjh]
//
// Roles: api (Netlify, transaction pooler :6543), indexer, scheduler, verifier (worker host,
// session pooler :5432). The group roles and their grants come from scripts/rewards/database-roles.sql.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d;};
const ROLES={api:6543,indexer:5432,scheduler:5432,verifier:5432};

function scramVerifier(password,{salt=crypto.randomBytes(16),iterations=4096}={}){
 const salted=crypto.pbkdf2Sync(password.normalize('NFKC'),salt,iterations,32,'sha256');
 const hmac=(k,m)=>crypto.createHmac('sha256',k).update(m).digest();
 const stored=crypto.createHash('sha256').update(hmac(salted,'Client Key')).digest(),server=hmac(salted,'Server Key');
 return`SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored.toString('base64')}:${server.toString('base64')}`;
}
function sqlFor(role,verifier){
 const login=`rebound_${role}_login`;
 return[
  `DO $$ BEGIN`,
  `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${login}') THEN`,
  `    ALTER ROLE ${login} WITH LOGIN PASSWORD '${verifier}';`,
  `  ELSE`,
  `    CREATE ROLE ${login} WITH LOGIN PASSWORD '${verifier}' IN ROLE rebound_${role};`,
  `  END IF;`,
  `END $$;`,
  `ALTER ROLE ${login} SET search_path = rebound, public;`,
 ].join('\n');
}
module.exports={scramVerifier,sqlFor};

if(require.main===module){
 const role=arg('role');if(!ROLES[role]){console.error('--role must be one of '+Object.keys(ROLES).join(', '));process.exit(2);}
 const out=path.resolve(arg('out','./runtime-secrets')),host=arg('host','aws-0-eu-central-1.pooler.supabase.com'),port=Number(arg('port',ROLES[role])),project=arg('project','zuvefozubbgstyljfxjh');
 const password=crypto.randomBytes(24).toString('base64url');
 fs.mkdirSync(out,{recursive:true,mode:0o700});fs.chmodSync(out,0o700);
 const file=path.join(out,`${role}-database.url`);
 const url=`postgresql://rebound_${role}_login.${project}:${password}@${host}:${port}/postgres?sslmode=require`;
 fs.writeFileSync(file,url+'\n',{mode:0o600});fs.chmodSync(file,0o600);
 console.log(`-- Run in the Supabase SQL editor (project ${project}). Contains a SCRAM verifier, not the password.\n`+sqlFor(role,scramVerifier(password)));
 console.log(`\n# Connection URL written to ${file} (mode 600). Point ${role.toUpperCase()}_DATABASE_URL_FILE at it${role==='api'?' — or paste it into Netlify as DATABASE_URL without displaying it':''}.`);
}
