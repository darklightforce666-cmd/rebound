'use strict';
// End-to-end cycle engine against the COMPILED V3 program (LiteSVM) and PostgreSQL (PGlite):
// snapshot → holder-only deposit → verifier-cosigned Fund → due-time payouts; crash/timeout
// recovery without duplicate settlement; manual plans that expire; concurrent workers; dry run.
const test=require('node:test'),assert=require('node:assert/strict');
const {Keypair,Transaction,PublicKey}=require('@solana/web3.js');
const {SvmConnection,A}=require('./svm-connection.cjs'),{supabaseDb}=require('./pg.cjs'),{chain}=require('./chain-fixture.cjs');
const W3=require('../../server/rewards/wire-v3.cjs'),P3=require('../../server/rewards/policy-v3.cjs'),C=require('../../server/rewards/cycle-v3.cjs'),V=require('../../server/rewards/verifier-v3.cjs'),T=require('../../server/rewards/transport-v3.cjs');
const SOL=10n**9n,USD=10n**12n,T0=1_800_000_000,TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
process.env.REWARDS_MAX_EXECUTION_MODE='mainnet_test';

async function world({automatic=true,mode='mainnet_test',holders=3}={}){
 const admin=Keypair.generate(),feePayer=Keypair.generate(),publisher=Keypair.generate(),verifier=Keypair.generate(),guardian=Keypair.generate(),dev=Keypair.generate();
 const program=Keypair.generate().publicKey;C.bind(program);
 const conn=new SvmConnection({program,admin:admin.publicKey});conn.setTime(T0,1000);
 for(const k of [admin,feePayer,publisher,dev])conn.airdrop(k.publicKey,100n*SOL);
 const send=async(ixs,signers)=>{const {blockhash}=await conn.getLatestBlockhash();const tx=new Transaction({feePayer:signers[0].publicKey,recentBlockhash:blockhash}).add(...ixs);tx.sign(...signers);const sig=await conn.sendRawTransaction(tx.serialize());return sig;};
 await send([W3.I.initialize(program,{admin:admin.publicKey,programData:conn.programData,publisher:publisher.publicKey,verifier:verifier.publicKey,guardian:guardian.publicKey,policy:P3.POLICY_HASH,testMode:false})],[admin]);
 const mint=Keypair.generate().publicKey,md=Buffer.alloc(82);md.writeBigUInt64LE(10n**15n,36);md[44]=6;md[45]=1;
 conn.svm.setAccount({address:A(mint),lamports:1_461_600n,programAddress:A(new PublicKey(TOKEN)),executable:false,data:md,space:82n});
 await send([W3.I.registerPrimary(program,{admin:admin.publicKey,mint,fundingWallet:dev.publicKey})],[admin]);
 await send([W3.I.startPrimary(program,{admin:admin.publicKey,mint})],[admin]);
 // Holders (real keys, existing accounts) and their finalized history.
 const people=Array.from({length:holders},()=>Keypair.generate().publicKey.toBase58());for(const p of people)conn.airdrop(new PublicKey(p),10_000_000n);
 const c=chain({startSlot:100,timeOf:s=>T0+(s-100)*10});const hi={vSol:300n*SOL,vTok:10n**12n};
 people.forEach((p,i)=>c.tx(x=>x.buy(p,'acct'+i,1_000_000n,{lamports:BigInt(4-i)*SOL,...hi})));
 c.tx(x=>x.buy(Keypair.generate().publicKey.toBase58(),'late',10n**9n,{lamports:1_000_000n,vSol:30n*SOL,vTok:10n**12n}));   // price drops
 const db=await supabaseDb();const mintS=mint.toBase58();
 await db.query("UPDATE reward_platform SET execution_mode=$1,test_allowlist_mints=$2,test_allowlist_wallets=$3,spend_cap_action_lamports=$4,spend_cap_cycle_lamports=$4,spend_cap_total_lamports=$5 WHERE namespace='mainnet_test'",[mode,[mintS],people,String(50n*SOL),String(500n*SOL)]);
 await db.query("INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version) VALUES($1,$2,'active','primary','mainnet_test','v3','rebound-v3.0')",[mintS,P3.POLICY_HASH]);
 const sol=cutoff=>[{time:cutoff-70,price:100n*USD,conf:0n},{time:cutoff-40,price:100n*USD,conf:0n},{time:cutoff-10,price:100n*USD,conf:0n}];
 const inputs=async(coinRow,n,cutoff)=>({events:c.events,coverage:{complete:true,throughSlot:10_000},excluded:new Set(['CurvePDA']),fx:()=>({price:100n*USD,conf:0n,time:0,source:'test'}),solSeries:sol(cutoff)});
 const ports={db,connection:conn,program,feePayer,publisher,verifierKey:verifier.publicKey,worker:'w1',
  verifier:{cosign:V.cosigner({db,program,key:verifier,inputs})},inputs,cutoffSlot:async()=>1500,now:async()=>conn.getBlockTime(),
  devSigner:async()=>automatic?dev:null,primaryAwaiting:async()=>2n*SOL,sponsorRent:false};
 conn.sent=0;   // count only what the engine sends
 return{conn,db,ports,program,mint,mintS,dev,admin,people,chain:c,send};
}
// The worker ticks every few seconds; tests tick a few times to let submissions settle.
const ticks=async(w,k=4,ports=w.ports)=>{let r;for(let i=0;i<k;i++){w.conn.finalizeAll();r=await C.tick(ports,w.mintS);}return r;};
const cycleRow=async(w,n=1)=>(await w.db.query('SELECT * FROM reward_cycles WHERE id=$1',[`${w.mintS}:${n}`])).rows[0];
const awards=async(w,n=1)=>(await w.db.query('SELECT * FROM reward_awards WHERE cycle_id=$1 ORDER BY leaf_index',[`${w.mintS}:${n}`])).rows;

test('automatic primary cycle: cutoff snapshot → holder-only deposit → cosigned Fund → payouts at due time',async()=>{
 const w=await world();try{
  assert.equal((await C.tick(w.ports,w.mintS)).open,null);                      // before the first cutoff: nothing
  w.conn.setTime(T0+1800-60,2000);const r=await ticks(w);
  const row=await cycleRow(w);assert.equal(row.state,'funded',JSON.stringify(r));
  const coin=W3.decode('coin',(await w.conn.getAccountInfo(W3.addresses(w.program,w.mint).coin)).data);
  const total=BigInt(row.total_lamports);assert.equal(coin.deposits,total);assert.equal(coin.holderReserved,total);assert.equal(coin.holderUnallocated,0n);
  assert.ok(total>0n&&total<=2n*SOL);
  // Before scheduled_end nothing is paid; at scheduled_end everything is.
  assert.equal((await C.tick(w.ports,w.mintS)).results[0].state,'funded');
  const before=await Promise.all(w.people.map(p=>w.conn.getBalance(new PublicKey(p))));
  w.conn.setTime(T0+1800,2100);await ticks(w);
  assert.equal((await cycleRow(w)).state,'complete');const as=await awards(w);assert.ok(as.every(a=>a.state==='paid'));
  const after=await Promise.all(w.people.map(p=>w.conn.getBalance(new PublicKey(p))));
  for(const a of as){const i=w.people.indexOf(a.recipient);assert.equal(BigInt(after[i]-before[i]),BigInt(a.amount_lamports));}
  const c2=W3.decode('coin',(await w.conn.getAccountInfo(W3.addresses(w.program,w.mint).coin)).data);assert.equal(c2.holderPaid,total);assert.equal(c2.holderReserved,0n);
  const logs=(await w.db.query("SELECT event_type FROM reward_logs WHERE component='scheduler' ORDER BY id")).rows.map(r=>r.event_type);
  for(const e of ['cycle_funding_pending','cycle_funded','cycle_paying','cycle_complete'])assert.ok(logs.includes(e),e);
 }finally{await w.db.close();}
});

test('ambiguous broadcasts and crashes never duplicate a deposit or a payment',async()=>{
 const w=await world();try{
  w.conn.setTime(T0+1740,2000);w.conn.faults.dropResponse=1;                       // deposit lands, response lost
  let r=await C.tick(w.ports,w.mintS);assert.equal((await cycleRow(w)).state,'funding_pending');
  const sentAfterFirst=w.conn.sent;r=await ticks(w);                                 // reconcile: settled via on-chain counter, then Fund
  const coin=W3.decode('coin',(await w.conn.getAccountInfo(W3.addresses(w.program,w.mint).coin)).data);
  assert.equal(coin.deposits,BigInt((await cycleRow(w)).total_lamports));          // exactly one deposit
  assert.equal((await cycleRow(w)).state,'funded');
  w.conn.setTime(T0+1800,2100);w.conn.faults.dropResponse=1;await C.tick(w.ports,w.mintS);   // first payout: response lost
  const attempts=(await w.db.query("SELECT state FROM reward_chain_attempts WHERE job LIKE 'pay:%'")).rows.map(x=>x.state);assert.ok(attempts.includes('uncertain')||attempts.includes('finalized'));
  await ticks(w);assert.equal((await cycleRow(w)).state,'complete');
  const c2=W3.decode('coin',(await w.conn.getAccountInfo(W3.addresses(w.program,w.mint).coin)).data);assert.equal(c2.holderPaid,coin.deposits);   // nobody paid twice
  const paidRows=(await awards(w)).filter(a=>a.state==='paid').length;assert.equal(paidRows,(await awards(w)).length);
  assert.ok(sentAfterFirst>0);
 }finally{await w.db.close();}
});

test('manual mode waits for the dev wallet signature; an unsigned plan expires without credit; a signed plan funds',async()=>{
 const w=await world({automatic:false});try{
  w.conn.setTime(T0+1740,2000);await C.tick(w.ports,w.mintS);
  let row=await cycleRow(w);assert.equal(row.state,'awaiting_funding_signature');
  const intent=(await w.db.query('SELECT * FROM reward_intents WHERE id=$1',[row.funding_intent])).rows[0];assert.equal(intent.state,'awaiting_signature');
  assert.equal(w.conn.sent,0);                                                        // nothing moves without the owner
  await C.tick(w.ports,w.mintS);assert.equal((await cycleRow(w)).state,'awaiting_funding_signature');
  // Window closes → expired, awards released, no compensation credit, deposit never happened.
  w.conn.setTime(T0+1740+1800,3000);await C.tick(w.ports,w.mintS);
  assert.equal((await cycleRow(w)).state,'expired');assert.ok((await awards(w)).every(a=>a.state==='released'));
  const c=W3.decode('coin',(await w.conn.getAccountInfo(W3.addresses(w.program,w.mint).coin)).data);assert.equal(c.deposits,0n);
  // Cycle 2 is planned in the same tick after the expiry; the owner gets the exact plan to sign.
  const row2=await cycleRow(w,2);assert.equal(row2.state,'awaiting_funding_signature');
  const owner=[w.dev.publicKey.toBase58()];
  // Owner-facing calls run with the API's own database role (grants are part of what is tested).
  const asApi=async fn=>{await w.db.query('SET ROLE rebound_api');try{return await fn();}finally{await w.db.query('RESET ROLE');}};
  const Api={manualPlan:(...a)=>asApi(()=>C.manualPlan(...a)),submitManualDeposit:(...a)=>asApi(()=>C.submitManualDeposit(...a))};
  await assert.rejects(Api.manualPlan(w.ports,{mint:w.mintS,wallets:[Keypair.generate().publicKey.toBase58()]}),e=>e.code==='FORBIDDEN');   // only the funding wallet
  let plan=await Api.manualPlan(w.ports,{mint:w.mintS,wallets:owner});
  assert.equal(plan.holderOnly,true);assert.equal(plan.signer,owner[0]);assert.equal(plan.amountLamports,row2.total_lamports);
  const signPlan=p=>{const tx=Transaction.from(Buffer.from(p.transaction,'base64'));tx.sign(w.dev);return tx.serialize().toString('base64');};
  // A tampered amount is refused before anything is broadcast.
  const t0=Transaction.from(Buffer.from(plan.transaction,'base64'));const bad=new Transaction({feePayer:w.dev.publicKey,recentBlockhash:t0.recentBlockhash})
   .add({...t0.instructions[0],data:W3.I.depositHolders(w.program,{fundingWallet:w.dev.publicKey,mint:w.mint,amount:1n}).data});bad.sign(w.dev);
  await assert.rejects(Api.submitManualDeposit(w.ports,{mint:w.mintS,intentId:plan.intentId,serialized:bad.serialize().toString('base64'),wallets:owner}),e=>e.code==='FORBIDDEN');
  assert.equal(w.conn.sent,0);
  // The signed deposit never reaches the network: once its blockhash has expired the plan returns to the owner.
  w.conn.faults.rejectSend=2;                                                       // submission and the first rebroadcast both refused
  let sub=await Api.submitManualDeposit(w.ports,{mint:w.mintS,intentId:plan.intentId,serialized:signPlan(plan),wallets:owner});assert.equal(sub.state,'uncertain');
  assert.equal((await cycleRow(w,2)).state,'awaiting_funding_signature');           // the API never moves cycles
  await C.tick(w.ports,w.mintS);assert.equal((await cycleRow(w,2)).state,'funding_pending');   // still possibly landing: identical bytes rebroadcast
  w.conn.advance({blocks:300});await C.tick(w.ports,w.mintS);                       // blockhash expired, never landed → back to the owner
  assert.equal((await cycleRow(w,2)).state,'awaiting_funding_signature');
  const stale=plan.lastValidBlockHeight;plan=await Api.manualPlan(w.ports,{mint:w.mintS,wallets:owner});assert.ok(plan.lastValidBlockHeight>stale);   // fresh blockhash, same deposit
  sub=await Api.submitManualDeposit(w.ports,{mint:w.mintS,intentId:plan.intentId,serialized:signPlan(plan),wallets:owner});assert.equal(sub.state,'submitted');
  await ticks(w);assert.equal((await cycleRow(w,2)).state,'funded');
  const c2=W3.decode('coin',(await w.conn.getAccountInfo(W3.addresses(w.program,w.mint).coin)).data);assert.equal(c2.deposits,BigInt(row2.total_lamports));   // exactly one deposit
  await assert.rejects(Api.submitManualDeposit(w.ports,{mint:w.mintS,intentId:plan.intentId,serialized:signPlan(plan),wallets:owner}),e=>e.code==='PLAN_STALE');
 }finally{await w.db.close();}
});

test('concurrent workers create one cycle and one Fund; dry run signs nothing',async()=>{
 const w=await world();try{
  w.conn.setTime(T0+1740,2000);
  const [a,b]=await Promise.all([C.tick({...w.ports,worker:'A'},w.mintS),C.tick({...w.ports,worker:'B'},w.mintS)]);
  assert.ok([a.state,b.state].includes('busy'));assert.equal((await w.db.query('SELECT count(*)::int n FROM reward_cycles')).rows[0].n,1);
  await ticks(w);assert.equal((await w.db.query("SELECT count(*)::int n FROM reward_chain_attempts WHERE job LIKE 'fund:%'")).rows[0].n,1);
 }finally{await w.db.close();}
 const d=await world({mode:'dry_run'});try{
  d.conn.setTime(T0+1740,2000);const r=await C.tick(d.ports,d.mintS);
  assert.equal(d.conn.sent,0);assert.equal((await cycleRow(d)).state,'funding_pending');assert.equal(r.results[0].code,'DRY_RUN');
  assert.ok((await awards(d)).length>0);                                              // full real calculation, nothing signed
 }finally{await d.db.close();}
});

test('recipients whose accounts do not exist keep the award as a liability until rent is available',async()=>{
 const w=await world({holders:1});try{
  const fresh=Keypair.generate().publicKey.toBase58();                                // never funded account
  w.chain.skipTo(110).tx(x=>x.buy(fresh,'fresh1',10n,{lamports:100000n,fee:0n,creatorFee:0n,vSol:300n*SOL,vTok:10n**12n}));
  await w.db.query("UPDATE reward_platform SET test_allowlist_wallets=array_append(test_allowlist_wallets,$1) WHERE namespace='mainnet_test'",[fresh]);
  w.conn.setTime(T0+1740,2000);await ticks(w);w.conn.setTime(T0+1800,2100);await ticks(w);
  const tiny=(await awards(w)).find(a=>a.recipient===fresh);
  assert.ok(tiny,'the fresh wallet must hold an award');assert.ok(BigInt(tiny.amount_lamports)<890880n,'award below the rent-exempt minimum');
  assert.equal(tiny.state,'deferred_rent');assert.equal((await cycleRow(w)).state,'partially_paid');   // liability kept, others paid
  w.ports.sponsorRent=true;await ticks(w);assert.equal((await cycleRow(w)).state,'complete');
  assert.ok(await w.conn.getBalance(new PublicKey(fresh))>=Number(tiny.amount_lamports));
 }finally{await w.db.close();}
});
