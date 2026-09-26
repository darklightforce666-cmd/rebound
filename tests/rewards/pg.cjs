'use strict';
// Test database: real PostgreSQL engine (PGlite) with the exact Supabase objects REBOUND
// depends on emulated (scripts/rewards/supabase-emulation.sql), all migrations, policy seed
// and the runtime role grants.
const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const DB=require('../../server/rewards/db.cjs'),P3=require('../../server/rewards/policy-v3.cjs');
async function supabaseDb({roles=true}={}){
 const db=new PGlite();await DB.migrate(db,{emulateSupabase:true});await P3.seed(db);
 if(roles)await db.exec(await fs.readFile(path.join(__dirname,'../../scripts/rewards/database-roles.sql'),'utf8'));
 await db.exec('SET search_path TO rebound, public');return db;
}
// Run fn as a database role with (optional) Supabase JWT claims; always rolled back.
async function as(db,role,claims,fn){
 await db.query('BEGIN');
 try{await db.query(`SET LOCAL ROLE ${role}`);if(claims)await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);return await fn(db);}
 finally{await db.query('ROLLBACK');}
}
// Same, but commits (for server-role writes that later assertions read).
async function asCommit(db,role,fn){await db.query('BEGIN');try{await db.query(`SET LOCAL ROLE ${role}`);const r=await fn(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}}
async function user(db,{wallet,domain='rebound.wtf',metadata={}}){
 const id=crypto.randomUUID();
 await db.query('INSERT INTO auth.users(id,raw_user_meta_data) VALUES($1,$2)',[id,JSON.stringify(metadata)]);
 if(wallet)await db.query('INSERT INTO auth.identities(user_id,provider,provider_id,identity_data) VALUES($1,$2,$3,$4)',[id,'web3','web3:solana:'+wallet,JSON.stringify({sub:'web3:solana:'+wallet,custom_claims:{domain,chain:'solana',address:wallet}})]);
 return{id,claims:{sub:id,role:'authenticated'}};
}
module.exports={supabaseDb,as,asCommit,user};
