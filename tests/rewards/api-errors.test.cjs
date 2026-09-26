'use strict';
// Database errors never reach API clients (constraint/index/table names stay server-side).
const test=require('node:test'),assert=require('node:assert/strict');
test('SQLSTATE errors map to CONFLICT/UNAVAILABLE without their text; plain validation messages still pass through',async()=>{
 const saved=process.env.DATABASE_URL;delete process.env.DATABASE_URL;
 try{
 const F=require('../../netlify/functions/rewards.cjs'),H=F._internal.handlers.GET,orig=H.config;
 const call=async err=>{H.config=async()=>{throw err;};try{const r=await F.handler({httpMethod:'GET',queryStringParameters:{action:'config'},headers:{}});return{status:r.statusCode,body:JSON.parse(r.body)};}finally{H.config=orig;}};
 const pg=(code,message)=>Object.assign(Error(message),{code,severity:'ERROR',routine:'x'});
 let r=await call(pg('23505','duplicate key value violates unique constraint "reward_funding_wallets_live"'));
 assert.equal(r.status,409);assert.equal(r.body.code,'CONFLICT');assert.doesNotMatch(JSON.stringify(r.body),/reward_funding_wallets_live|duplicate/);
 r=await call(pg('42501','permission denied for table reward_funding_accounts'));
 assert.equal(r.status,503);assert.equal(r.body.code,'UNAVAILABLE');assert.doesNotMatch(JSON.stringify(r.body),/reward_funding_accounts/);
 r=await call(pg('23514','new row violates check constraint "x"'));assert.equal(r.status,503);
 r=await call(Object.assign(Error('Invalid mint address'),{code:'INVALID_BODY'}));assert.equal(r.status,400);assert.equal(r.body.message,'Invalid mint address');
 }finally{if(saved!==undefined)process.env.DATABASE_URL=saved;}
});
