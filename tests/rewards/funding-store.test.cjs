'use strict';
// Primary funding ledger persisted in PostgreSQL: idempotent, conserved, backing-checked.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {supabaseDb}=require('./pg.cjs'),FS=require('../../server/rewards/funding-store.cjs'),F=require('../../server/rewards/primary-funding.cjs');
const SOL=1000000000n,DEV='DevWallet111',SYS='11111111111111111111111111111111';
let slot=5000;
function tx({sig,payer='Other',pre,post,transfers=[]}){slot++;const keys=[payer,DEV,...transfers.flatMap(t=>[t.from,t.to])].filter((k,i,a)=>a.indexOf(k)===i);
 return{slot,blockTime:slot,transaction:{signatures:[sig],message:{accountKeys:keys,instructions:transfers.map(t=>({programId:SYS,parsed:{type:'transfer',info:{source:t.from,destination:t.to,lamports:Number(t.lamports)}}}))}},meta:{err:null,fee:5000,preBalances:keys.map(k=>k===DEV?Number(pre):0),postBalances:keys.map(k=>k===DEV?Number(post):0),innerInstructions:[]}};}
async function setup(){
 const db=await supabaseDb();
 await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES('PRIMARY','h','registered','primary','production','v3','rebound-v3.1')");
 await db.query("INSERT INTO reward_funding_wallets(id,namespace,mint,address,ownership_proof) VALUES($1,'production','PRIMARY',$2,'{}')",[crypto.randomUUID(),DEV]);
 return db;
}
const acct=async db=>(await db.query('SELECT * FROM reward_funding_accounts WHERE mint=$1',['PRIMARY'])).rows[0];
test('opening credit once; wallet credits split once; deposits move liability; replays add nothing',async()=>{
 const db=await setup();try{
  await FS.recordOpening(db,{mint:'PRIMARY',wallet:DEV,balance:2n*SOL,requestedCredit:SOL,operationalReserve:100000000n,slot:5000,time:5000});
  await assert.rejects(FS.recordOpening(db,{mint:'PRIMARY',wallet:DEV,balance:2n*SOL,requestedCredit:SOL,operationalReserve:0n,slot:5000,time:5000}),/already recorded/);
  let a=await acct(db);assert.equal(a.credited,'1000000000');assert.equal(a.holder_awaiting_transfer,'850000000');assert.equal(a.other_settled,'150000000');
  const intents=new Map([['dep',{kind:'holder_deposit',amount:'850000000'}]]);
  const txs=[tx({sig:'in1',pre:2n*SOL,post:3n*SOL,transfers:[{from:'X',to:DEV,lamports:SOL}]}),tx({sig:'dep',payer:'Fee',pre:3n*SOL,post:3n*SOL-850000000n,transfers:[{from:DEV,to:'Treasury',lamports:850000000n}]})];
  const c=txs.map(t=>F.classify(t,DEV,intents));
  await FS.applyWalletTransactions(db,{mint:'PRIMARY',wallet:DEV,classified:c});
  await FS.applyWalletTransactions(db,{mint:'PRIMARY',wallet:DEV,classified:c});      // replay: nothing new
  a=await acct(db);
  assert.equal(a.credited,'2000000000');assert.equal(a.holder_awaiting_transfer,'850000000');assert.equal(a.holder_available,'850000000');assert.equal(a.other_settled,'300000000');
  assert.equal((await db.query('SELECT count(*)::int n FROM reward_funding_credits')).rows[0].n,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM reward_ledger')).rows[0].n,2);
  await assert.rejects(db.query("UPDATE reward_funding_accounts SET other_settled=other_settled+1 WHERE mint='PRIMARY'"),/check/i);   // conservation enforced by the DB
  await assert.rejects(db.query("UPDATE reward_funding_credits SET gross_lamports=1"),/immutable/);
 }finally{await db.close();}
});
test('owner spending that eats holder liabilities pauses the coin and logs the exact shortfall',async()=>{
 const db=await setup();try{
  await FS.recordOpening(db,{mint:'PRIMARY',wallet:DEV,balance:SOL,requestedCredit:SOL,operationalReserve:0n,slot,time:slot});
  const spend=tx({sig:'spend',payer:'P',pre:SOL,post:500000000n,transfers:[{from:DEV,to:'Owner',lamports:500000000n}]});
  await FS.applyWalletTransactions(db,{mint:'PRIMARY',wallet:DEV,classified:[F.classify(spend,DEV)]});
  const coin=(await db.query("SELECT status,blocked_reason FROM reward_coins WHERE mint='PRIMARY'")).rows[0];assert.deepEqual([coin.status,coin.blocked_reason],['paused','insufficient_backing']);
  const log=(await db.query("SELECT * FROM reward_logs WHERE error_code='INSUFFICIENT_BACKING'")).rows[0];assert.match(log.safe_message,/by 350000000 lamports/);
 }finally{await db.close();}
});
