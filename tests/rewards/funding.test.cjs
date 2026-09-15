'use strict';
// Synthetic RPC history fixtures test policy boundaries, not a real wallet's identity.
const test=require('node:test'),assert=require('node:assert/strict'),{Keypair}=require('@solana/web3.js');
const F=require('../../server/rewards/funding.cjs'),A=require('../../server/rewards/assets.cjs');
const key=()=>Keypair.generate().publicKey.toBase58();
test('fresh funding verification ignores forged publisher audit and link projections',async()=>{
 const wallet=key(),source=key(),mint=key(),lot={id:'buy',wallet,mint,at:3000000,cost:'1000000000',slot:2,provenance:{signature:'buy',route:'0'}};
 const fund={slot:1,blockTime:2999900,transaction:{signatures:['fund'],message:{accountKeys:[wallet,source],instructions:Array.from({length:10},()=>({programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source,destination:wallet,lamports:90000000}}}))}},meta:{err:null,innerInstructions:[],preBalances:[100000000,2000000000],postBalances:[1000000000,1100000000]}};
 const buy={slot:2,blockTime:3000000,transaction:{signatures:['buy'],message:{accountKeys:[wallet],instructions:[]}},meta:{err:null,innerInstructions:[],preBalances:[1000000000],postBalances:[0]}};
 let reads=0,corrections=[];
 const rpc={call:async(method,args)=>{if(method==='getGenesisHash')return'g';if(method==='getSignaturesForAddress')return args[1].before?[]:[{signature:'buy',slot:2,blockTime:3000000},{signature:'fund',slot:1,blockTime:2999900}];if(method==='getTransaction'){reads++;return args[0]==='buy'?buy:fund;}if(method==='getBlock')return{transactions:[args[0]===2?buy:fund]};throw Error(method);}};
 const db={query:async(sql)=>{if(sql.startsWith('SELECT genesis'))return{rows:[{genesis:'g'}]};if(sql.startsWith('SELECT edge_id'))return{rows:corrections};if(sql.startsWith('SELECT * FROM reward_services'))return{rows:[{address:source,classification:'private-wallet-verified',evidence:{review:'fixture'}}]};if(sql.startsWith('SELECT c.mint'))return{rows:[]};if(sql.startsWith('SELECT'))throw Error('Untrusted stored decision read: '+sql);return{rows:[]};}};
 const context={db,rpc,coin:{mint,deployment:'d'},replay:{lots:[lot]},cutoff:{slot:2,time:3000000}};
 const first=await F.refresh(context);assert.equal(first.links.length,1);assert.equal(first.links[0].status,'supported');assert.equal(first.wallets[0].complete,true);assert.equal(reads,2);
 corrections=[{edge_id:first.links[0].id}];const second=await F.refresh(context);assert.equal(second.links.length,0);assert.equal(reads,4,'each authorization rereads chain funding evidence');
 await assert.rejects(()=>F.refresh({...context,rpc:{call:async()=> 'wrong-chain'}}),/network mismatch/);
});
test('rent and donations stay outside collected fees, while underfunding fails',()=>{
 const coin={unallocated:8500,reserved:0,operationsPayable:1500};
 assert.deepEqual(A.backing({coin,balance:12000,rent:1000}),{liabilities:10000n,surplus:1000n});
 assert.throws(()=>A.backing({coin,balance:10999,rent:1000}),/do not cover/);
});
