'use strict';
const {Pool}=require('pg'),fs=require('node:fs/promises'),path=require('node:path');
const {stable,conserved,int}=require('./policy.cjs');
const W=require('./wire.cjs');
function connect(url=process.env.DATABASE_URL){if(!url)throw Error('DATABASE_URL is required');return new Pool({connectionString:url,max:6,application_name:'rebound-rewards-v2',statement_timeout:20000,connectionTimeoutMillis:10000});}
async function transaction(db,fn,{serializable=true}={}){
 const client=typeof db.connect==='function'&&typeof db.release!=='function'?await db.connect():db;
 try{await client.query(serializable?'BEGIN ISOLATION LEVEL SERIALIZABLE':'BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{if(client!==db)client.release();}
}
async function migrate(db){
 await db.query('CREATE TABLE IF NOT EXISTS reward_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
 for(const file of (await fs.readdir(path.join(__dirname,'migrations'))).filter(x=>/^\d+.*\.sql$/.test(x)).sort()){
  const version=Number(file.split('_')[0]);if((await db.query('SELECT version FROM reward_schema_migrations WHERE version=$1',[version])).rows.length)continue;
  const sql=await fs.readFile(path.join(__dirname,'migrations',file),'utf8');if(db.exec)await db.exec(sql);else await db.query(sql);
 }
}
async function audit(db,kind,evidence,{mint=null,wallet=null,actor='worker'}={}){await db.query('INSERT INTO reward_audit(kind,mint,wallet,actor,evidence) VALUES($1,$2,$3,$4,$5)',[kind,mint,wallet,actor,stable(evidence)]);}
async function lockPosition(db,mint,wallet){
 await db.query('INSERT INTO reward_positions(mint,wallet) VALUES($1,$2) ON CONFLICT DO NOTHING',[mint,wallet]);
 return(await db.query('SELECT * FROM reward_positions WHERE mint=$1 AND wallet=$2 FOR UPDATE',[mint,wallet])).rows[0];
}
function chainAccounting(c){return{receipts:c.receipts,unallocated:c.unallocated,reserved:c.reserved,paid:c.paid,operationsPayable:c.operationsPayable,operationsPaid:c.operationsPaid,splitRemainder:c.splitRemainder};}
async function journalChain(db,{mint,kind,reference,signature,slot,account,expectedDelta,evidence}){
 // Called only after independent verification of a finalized transaction and
 // the actual program-owned account at/after its slot. Never on attempted sends.
 return transaction(db,async tx=>{
  const prior=(await tx.query('SELECT * FROM reward_journal WHERE mint=$1 AND kind=$2 AND reference=$3',[mint,kind,reference])).rows[0];if(prior)return prior;
  const old=(await tx.query('SELECT * FROM reward_accounts WHERE mint=$1 FOR UPDATE',[mint])).rows[0];if(!old)throw Error('Coin accounting not initialized');
  if(old.chain_slot!==null&&BigInt(slot)<BigInt(old.chain_slot))throw Error('Accounting evidence moved backwards');
  const next=chainAccounting(account);if(!conserved(next))throw Error('Chain conservation failed');
  const before={receipts:old.receipts,unallocated:old.unallocated,reserved:old.reserved,paid:old.paid,operationsPayable:old.operations_payable,operationsPaid:old.operations_paid,splitRemainder:old.split_remainder};
  if(expectedDelta)for(const[k,v]of Object.entries(expectedDelta))if(BigInt(next[k])-BigInt(before[k])!==BigInt(v))throw Error('Unreconciled intervening settlement');
  const id=W.hash(mint,kind,reference).toString('hex');
  await tx.query('UPDATE reward_accounts SET receipts=$2,unallocated=$3,reserved=$4,paid=$5,operations_payable=$6,operations_paid=$7,split_remainder=$8,chain_slot=$9 WHERE mint=$1',[mint,...['receipts','unallocated','reserved','paid','operationsPayable','operationsPaid','splitRemainder'].map(k=>String(next[k])),slot]);
  await tx.query('INSERT INTO reward_journal(id,mint,kind,reference,entries,before_state,after_state,chain_signature,chain_slot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,mint,kind,reference,stable(evidence),stable(before),stable(next),signature,slot]);return{id,...next};
 });
}
async function settleAllocation(db,{mint,round,index,paid,released,signature,slot,positionVersion,positionTotals,evidence}){
 return transaction(db,async tx=>{
  const row=(await tx.query('SELECT * FROM reward_allocations WHERE mint=$1 AND round_id=$2 AND leaf_index=$3 FOR UPDATE',[mint,round,index])).rows[0];if(!row)throw Error('Unknown allocation');
  if(row.settlement_signature){if(row.settlement_signature!==signature)throw Error('Conflicting settlement evidence');return row;}
  const p=await lockPosition(tx,mint,row.wallet),n=int(paid),r=int(released);if(n+r!==int(row.maximum))throw Error('Settlement does not conserve reservation');
  if(!positionTotals&&int(p.reserved)<int(row.maximum))throw Error('Position reservation mismatch');
  const state=n===0n?'canceled':r>0n?'reduced':'paid';
  await tx.query('UPDATE reward_allocations SET paid=$4,released=$5,active=0,state=$6,state_version=state_version+1,check_evidence=$7,settlement_signature=$8 WHERE mint=$1 AND round_id=$2 AND leaf_index=$3',[mint,round,index,String(n),String(r),state,stable(evidence),signature]);
  const totals=positionTotals||{paid:int(p.paid)+n,active:int(p.reserved)-int(row.maximum)};
  await tx.query('UPDATE reward_positions SET paid=$3,reserved=$4,version=$5,latest_check_slot=$6 WHERE mint=$1 AND wallet=$2',[mint,row.wallet,String(totals.paid),String(totals.active),positionVersion,slot]);
  await tx.query("UPDATE reward_authorizations SET state='settled' WHERE mint=$1 AND wallet=$2 AND position_version<$3 AND state='issued'",[mint,row.wallet,positionVersion]);
  await audit(tx,'allocation_settled',{round,index,paid:n,released:r,signature,slot,...evidence},{mint,wallet:row.wallet});return{state,paid:n,released:r};
 });
}
async function leaseJob(db,worker,seconds=120){
 return transaction(db,async tx=>{const r=(await tx.query("SELECT * FROM reward_jobs WHERE due_at<=now() AND (state='pending' OR (state='running' AND lease_until<now())) ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];if(!r)return null;await tx.query("UPDATE reward_jobs SET state='running',lease_owner=$2,lease_until=now()+($3::text||' seconds')::interval,attempts=attempts+1 WHERE id=$1",[r.id,worker,seconds]);return r;},{serializable:false});
}
module.exports={connect,transaction,migrate,audit,lockPosition,journalChain,settleAllocation,leaseJob};
