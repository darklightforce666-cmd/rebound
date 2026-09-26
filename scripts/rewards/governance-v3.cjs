#!/usr/bin/env node
'use strict';
// Program governance from the command line, signed by a LOCAL admin key file (private test).
// Production governance should be signed from the admin dashboard with a Ledger or through a
// Squads multisig instead. Every action is simulated first; nothing is sent with --dry.
//
//   SOLANA_RPC_URL=… node scripts/rewards/governance-v3.cjs --program <ID> --admin ./runtime-secrets/admin.json <action> [options]
//   actions:
//     status
//     initialize --publisher <A> --verifier <A> --guardian <A> [--test-mode]
//     set-target --mint <PRIMARY>
//     register-primary --mint <PRIMARY> --funding-wallet <DEV>
//     start-primary --mint <PRIMARY>
//     set-funding-wallet --mint <PRIMARY> --funding-wallet <DEV>
//     pause | request-resume | resume
const fs=require('node:fs');
const {Connection,Keypair,PublicKey,Transaction,sendAndConfirmRawTransaction}=require('@solana/web3.js');
const W3=require('../../server/rewards/wire-v3.cjs'),P3=require('../../server/rewards/policy-v3.cjs');
const a=process.argv.slice(2),opt=(n,d)=>{const i=a.indexOf('--'+n);return i>=0?a[i+1]:d;},flag=n=>a.includes('--'+n);
const VALUED=new Set(['--program','--admin','--publisher','--verifier','--guardian','--mint','--funding-wallet']);
const action=a.find((x,i)=>!x.startsWith('--')&&!(i>0&&VALUED.has(a[i-1])));
(async()=>{
 const rpc=process.env.SOLANA_RPC_URL;if(!rpc)throw Error('SOLANA_RPC_URL is required');
 const program=new PublicKey(opt('program',process.env.REWARDS_PROGRAM_ID)),conn=new Connection(rpc,'confirmed');
 const dep=W3.addresses(program).deployment;
 if(action==='status'){
  const [p,d]=await conn.getMultipleAccountsInfo([program,dep]);
  console.log(JSON.stringify({program:program.toBase58(),executable:!!p?.executable,deployment:dep.toBase58(),initialized:!!d,state:d?W3.decode('deployment',d.data):null},(k,v)=>typeof v==='bigint'?String(v):v,1));
  const mint=opt('mint');if(mint){const c=await conn.getAccountInfo(W3.addresses(program,new PublicKey(mint)).coin);console.log(JSON.stringify({coin:c?W3.decode('coin',c.data):null},(k,v)=>typeof v==='bigint'?String(v):v,1));}
  return;
 }
 const admin=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(opt('admin'),'utf8'))));
 const pk=n=>{const v=opt(n);if(!v||v.startsWith('--'))throw Error(`--${n} <address> is required for ${action}`);return new PublicKey(v);};
 const ix={
  'initialize':()=>W3.I.initialize(program,{admin:admin.publicKey,publisher:pk('publisher'),verifier:pk('verifier'),guardian:pk('guardian'),policy:flag('test-mode')?P3.hashOf(P3.TEST_POLICY):P3.POLICY_HASH,testMode:flag('test-mode')}),
  'set-target':()=>W3.I.setBuybackTarget(program,{admin:admin.publicKey,targetMint:pk('mint')}),
  'register-primary':()=>W3.I.registerPrimary(program,{admin:admin.publicKey,mint:pk('mint'),fundingWallet:pk('funding-wallet')}),
  'start-primary':()=>W3.I.startPrimary(program,{admin:admin.publicKey,mint:pk('mint')}),
  'set-funding-wallet':()=>W3.I.setFundingWallet(program,{admin:admin.publicKey,mint:pk('mint'),fundingWallet:pk('funding-wallet')}),
  'pause':()=>W3.I.pause(program,{authority:admin.publicKey}),'request-resume':()=>W3.I.requestResume(program,{admin:admin.publicKey}),'resume':()=>W3.I.resume(program,{admin:admin.publicKey}),
 }[action];
 if(!ix)throw Error('Unknown action '+action);
 const bh=await conn.getLatestBlockhash('confirmed');const tx=new Transaction({feePayer:admin.publicKey,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight}).add(ix());tx.sign(admin);
 const sim=await conn.simulateTransaction(tx);
 if(sim.value.err){console.error('Simulation rejected: '+(W3.errorName(sim.value.err)||JSON.stringify(sim.value.err))+'\n'+(sim.value.logs||[]).slice(-6).join('\n'));process.exitCode=1;return;}
 if(flag('dry')){console.log('Simulation OK (dry run, not sent). Units: '+sim.value.unitsConsumed);return;}
 const sig=await sendAndConfirmRawTransaction(conn,tx.serialize(),{signature:tx.signature&&require('bs58').encode(tx.signature),blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight},{commitment:'finalized',preflightCommitment:'confirmed'});
 console.log(`${action} finalized: https://solscan.io/tx/${sig}`);
})().catch(e=>{console.error('governance failed: '+e.message);process.exitCode=1;});
