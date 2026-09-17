'use strict';
// Execute with --no-experimental-require-module, as on the Lambda runtime.
// No credentials, database, network calls or signing are needed for this probe.
const assert=require('node:assert/strict');
delete process.env.DATABASE_URL;
delete process.env.SOLANA_RPC_URL;
process.env.REWARDS_TRANSFERS_ENABLED='false';
async function main(){
 const rewards=require('../netlify/functions/rewards.cjs');
 const chain=require('../netlify/functions/chain.cjs');
 const charts=require('../netlify/functions/charts.cjs');
 for(const name of ['launch','metadata','pump','worker','verifier-server'])require('../server/rewards/'+name+'.cjs');
 assert.equal(typeof charts.handler,'function');
 const health=await rewards.handler({httpMethod:'GET',queryStringParameters:{action:'health'}});
 assert.equal(health.statusCode,200);
 const body=JSON.parse(health.body);assert.equal(body.transfersEnabled,false);assert.equal(body.state,'setup_required');
 const launch=await rewards.handler({httpMethod:'POST',queryStringParameters:{action:'launch-prepare'},headers:{},body:'{}'});
 assert.equal(launch.statusCode,503);
 const status=await chain.handler({httpMethod:'GET',queryStringParameters:{action:'status'}});
 assert.equal(status.statusCode,503);assert.equal(JSON.parse(status.body).error,'RPC_NOT_CONFIGURED');
 console.log('All function modules load under Lambda-compatible CommonJS; missing setup fails closed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
