'use strict';
const crypto=require('node:crypto');
const {Connection,Transaction}=require('@solana/web3.js');
const DB=require('./db.cjs'),C=require('./config.cjs'),P=require('./policy.cjs'),W=require('./wire.cjs'),Pump=require('./pump.cjs'),I=require('./indexer.cjs'),S=require('./snapshot.cjs'),V=require('./verifier.cjs'),R=require('./receipts.cjs'),T=require('./transport.cjs'),D=require('./delivery.cjs'),Internal=require('./internal.cjs');
async function finalizedTransaction(connection,signature){if(!signature)return{definitivelyUnsettled:true};const tx=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});return tx&&!tx.meta?.err?{settled:true,slot:tx.slot,signature}:{definitivelyUnsettled:!tx};}
async function accountState(connection,program,address,type){const r=await connection.getAccountInfoAndContext(address,'finalized');if(!r.value)return null;if(!r.value.owner.equals(W.pk(program)))throw Error('Program account owner mismatch');return{...W.decode(r.value.data,type),slot:r.context.slot};}
async function reconcileCoin(db,connection,cfg,coin){
 const c=await accountState(connection,cfg.program,W.addresses(cfg.program,coin.mint).coin,'coin');if(!c)return;
 if(!P.conserved(c))throw Error('Onchain accounting invariant failed');
 const recent=await connection.getSignaturesForAddress(W.addresses(cfg.program,coin.mint).coin,{limit:1},'finalized');if(!recent.length)return;
 await DB.journalChain(db,{mint:coin.mint,kind:'reconciliation',reference:String(c.slot)+':'+W.hash(P.stable(c)).toString('hex'),signature:recent[0].signature,slot:c.slot,account:c,evidence:{source:'program-account',note:'Rent and excess balances remain outside collected-fee accounting'}});
 await require('./assets.cjs').reconcile(db,connection,cfg.program,coin.mint);
}
async function collectFees(context,coin,cycle){
 const {db,connection,cfg,payer,preflight}=context;
 const routing=await Pump.verifyRouting(connection,cfg.program,coin.mint);
 const send=(label,instructions)=>T.submit({...context,job:'collect:'+coin.mint+':'+cycle+':'+label,instructions,context:{mint:coin.mint,cycle,kind:label},readSettlement:sig=>finalizedTransaction(connection,sig)});
 if(routing.curve.complete){const{getAssociatedTokenAddressSync,NATIVE_MINT}=require('@solana/spl-token'),ata=getAssociatedTokenAddressSync(NATIVE_MINT,Pump.SDK.ammCreatorVaultPda(W.addresses(cfg.program,coin.mint).intake),true),info=await connection.getAccountInfo(ata,'finalized');if(info&&info.data.length>=72&&info.data.readBigUInt64LE(64)>0n){const r=await send('initial-amm-sweep',[await Pump.collectInitialGraduated(cfg.program,coin.mint,payer.publicKey)]);if(r.state!=='finalized')return r;}}
 const initialVault=Pump.SDK.creatorVaultPda(W.addresses(cfg.program,coin.mint).intake),initial=await connection.getAccountInfo(initialVault,'finalized');
 const rent=await connection.getMinimumBalanceForRentExemption(0);
 if(initial&&initial.lamports>rent){const result=await send('initial',[await Pump.collectInitial(cfg.program,coin.mint)]);if(!['finalized','dry-run'].includes(result.state))return result;}
 if(routing.curve.complete){
  const authority=Pump.SDK.ammCreatorVaultPda(Pump.SDK.feeSharingConfigPda(W.pk(coin.mint)));
  const {getAssociatedTokenAddressSync,NATIVE_MINT,TOKEN_PROGRAM_ID}=require('@solana/spl-token');
  const ata=getAssociatedTokenAddressSync(NATIVE_MINT,authority,true,TOKEN_PROGRAM_ID),info=await connection.getAccountInfo(ata,'finalized');
  if(info&&info.data.length>=72&&info.data.readBigUInt64LE(64)>0n){const instructions=await Pump.collect(coin.mint,payer.publicKey,routing.sharing,{graduated:true});const result=await send('amm-sweep',[instructions[0]]);if(!['finalized','dry-run'].includes(result.state))return result;}
 }
 const vault=await connection.getAccountInfo(Pump.SDK.creatorVaultPda(Pump.SDK.feeSharingConfigPda(W.pk(coin.mint))),'finalized');
 if(vault&&vault.lamports>rent)return send('distribution',await Pump.collect(coin.mint,payer.publicKey,routing.sharing));return{state:'finalized',reason:'no_pending_creator_fees'};
}
async function creditReceipts(context,coin){
 const {db,connection,cfg,payer}=context;const receipts=(await db.query("SELECT * FROM reward_receipts WHERE mint=$1 AND state IN ('verified','submitted') ORDER BY source_slot,id",[coin.mint])).rows;
 for(const r of receipts){
  const authorized=await Internal.call('/receipt',{receiptId:r.id}),a=authorized.authorization;
  if(authorized.verifier!==cfg.verifier||a.mint!==coin.mint||a.program!==cfg.program||BigInt(a.amount)!==BigInt(r.amount))throw Error('Receipt authorization mismatch');
  const message=W.receiptMessage(a);if(!message.equals(Buffer.from(authorized.message,'base64')))throw Error('Receipt message mismatch');
  const address=W.addresses(cfg.program,coin.mint,0,undefined,0,authorized.event).receipt;
  const result=await T.submit({...context,job:'receipt:'+r.id,instructions:[W.attest(cfg.verifier,message,Buffer.from(authorized.signature,'base64')),W.credit(cfg.program,payer.publicKey,a)],context:{receipt:r.id,sourceSlot:r.source_slot},readSettlement:async()=>{const s=await accountState(connection,cfg.program,address,'receipt');return s?{settled:true,...s}:{definitivelyUnsettled:true};}});
  if(result.state==='finalized')await db.query("UPDATE reward_receipts SET state='credited',onchain_receipt=$2,credit_signature=$3 WHERE id=$1",[r.id,address.toBase58(),result.signature||r.credit_signature]);else return result;
 }return{state:'finalized'};
}
async function reserveRound(context,coin,cycle){
 const {db,connection,cfg,payer,publisher}=context;
 let row=(await db.query('SELECT * FROM reward_rounds WHERE mint=$1 AND round_id=$2',[coin.mint,cycle])).rows[0];
 if(!row?.manifest){
  const cutoff=await S.finalizedCutoff(db,connection),{slot,time}=cutoff;
  if(Math.floor(time/1800)!==Number(cycle))return{state:'completed',reason:'superseded_unfunded_cycle'};
  const snap=await S.snapshot(db,connection,{mint:coin.mint,cutoff,program:cfg.program});if(!snap.complete)return{state:'blocked',reason:snap.reason};
  const proposal=V.manifestFor(snap,cfg.program,cycle);if(proposal.empty)return{state:'completed',reason:proposal.reason};
  await Internal.call('/manifest',{mint:coin.mint,round:cycle,cutoff,published:{hash:proposal.hash,manifest:proposal.manifest}});
  await db.query("INSERT INTO reward_rounds(mint,round_id,cutoff_slot,cutoff_time,state,root,manifest_hash,manifest,total) VALUES($1,$2,$3,$4,'verified',$5,$6,$7,$8) ON CONFLICT DO NOTHING",[coin.mint,cycle,slot,time,proposal.manifest.root,proposal.hash,P.stable(proposal.manifest),String(proposal.root.sum)]);
  row=(await db.query('SELECT * FROM reward_rounds WHERE mint=$1 AND round_id=$2',[coin.mint,cycle])).rows[0];
 }
 const root={hash:Buffer.from(row.root,'hex'),sum:BigInt(row.total)},cutoff={slot:Number(row.cutoff_slot),time:Number(row.cutoff_time)},published={hash:row.manifest_hash,manifest:row.manifest};
 const fund=W.fund(cfg.program,payer.publicKey,cfg.publisher,cfg.verifier,row.manifest.context,root,cutoff,row.manifest_hash),roundAddress=W.addresses(cfg.program,coin.mint,cycle).round;
 const existingRound=await accountState(connection,cfg.program,roundAddress,'round');
 if(!existingRound&&(await connection.getSlot('confirmed')-cutoff.slot>P.POLICY.indexLagSlots)){
  const live=(await db.query("SELECT * FROM reward_chain_attempts WHERE job=$1 AND state IN ('prepared','broadcast','uncertain')",['fund:'+coin.mint+':'+cycle])).rows[0];
  if(live)return T.reconcileAttempt(db,connection,live,async()=>{const r=await accountState(connection,cfg.program,roundAddress,'round');return r?{settled:true,...r}:{definitivelyUnsettled:true};});
  await db.query("UPDATE reward_rounds SET state='blocked',reason='unfunded_manifest_cutoff_expired' WHERE mint=$1 AND round_id=$2",[coin.mint,cycle]);return{state:'completed',reason:'unfunded_manifest_cutoff_expired'};
 }
 const funded=await T.submit({...context,job:'fund:'+coin.mint+':'+cycle,instructions:[fund],signers:[publisher],context:{mint:coin.mint,round:cycle,manifest:row.manifest_hash},readSettlement:async()=>{const r=await accountState(connection,cfg.program,roundAddress,'round');return r?{settled:true,...r}:{definitivelyUnsettled:true};},prepare:async blockhash=>{
  const original=new Transaction({feePayer:payer.publicKey,...blockhash}).add(fund);
  const checked=await Internal.call('/fund',{mint:coin.mint,round:cycle,cutoff,published,transaction:original.serialize({requireAllSignatures:false}).toString('base64')});
  const signed=Transaction.from(Buffer.from(checked.transaction,'base64'));if(!signed.serializeMessage().equals(original.serializeMessage()))throw Error('Verifier changed funding transaction');return signed;
 }});
 if(funded.state==='dry-run')return funded;if(funded.state!=='finalized')return funded;
 await db.query("UPDATE reward_rounds SET state='reserved',funding_signature=COALESCE(funding_signature,$3) WHERE mint=$1 AND round_id=$2",[coin.mint,cycle,funded.signature]);
 for(const award of row.manifest.allocations){
  const a=W.addresses(cfg.program,coin.mint,cycle,award.wallet,award.index),proof=award.proof.map(n=>({hash:Buffer.from(n.hash,'hex'),sum:BigInt(n.sum)}));
  const result=await T.submit({...context,job:'register:'+coin.mint+':'+cycle+':'+award.index,instructions:[W.register(cfg.program,payer.publicKey,row.manifest.context,{...award,proof})],context:{mint:coin.mint,round:cycle,index:award.index},readSettlement:async()=>{const state=await accountState(connection,cfg.program,a.allocation,'allocation');return state?{settled:true,...state}:{definitivelyUnsettled:true};}});
  if(result.state!=='finalized')return result;
  await DB.transaction(db,async tx=>{
   await DB.lockPosition(tx,coin.mint,award.wallet);const existing=(await tx.query('SELECT leaf_index FROM reward_allocations WHERE mint=$1 AND round_id=$2 AND leaf_index=$3',[coin.mint,cycle,award.index])).rows[0];if(existing)return;
   await tx.query("INSERT INTO reward_allocations(mint,round_id,leaf_index,wallet,maximum,active,proof,lot_shares,state) VALUES($1,$2,$3,$4,$5,$5,$6,$7,'reserved')",[coin.mint,cycle,award.index,award.wallet,award.amount,P.stable(award.proof),P.stable(award.lotIds)]);
   const chain=await S.chainPosition(connection,cfg.program,coin.mint,award.wallet);
   await tx.query('UPDATE reward_positions SET reserved=$3,paid=$4,version=$5 WHERE mint=$1 AND wallet=$2',[coin.mint,award.wallet,String(chain.active),String(chain.paid),String(chain.version)]);
  });
 }return{state:'reserved'};
}
async function cycle(context,coin,round){
 const {db,connection,cfg}=context;
 const lock=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[coin.mint])).rows[0].locked;if(!lock)return{state:'busy'};
 try{
  const collection=await collectFees(context,coin,round);await reconcileCoin(db,connection,cfg,coin);
  if(!['finalized','dry-run'].includes(collection.state))return collection;
  const cutoff=await S.finalizedCutoff(db,connection),replay=await S.replayCoin(db,coin,cutoff);
  if(!replay.complete)return{state:'blocked',reason:replay.reason};await R.stageReceipts(db,coin,replay);
  const receipts=await creditReceipts(context,coin);if(receipts.state!=='finalized')return receipts;
  await reconcileCoin(db,connection,cfg,coin);
  const operations=await releaseOperations(context,coin,round);
  const funded=await reserveRound(context,coin,round);
  const allocations=(await db.query('SELECT * FROM reward_allocations WHERE mint=$1 AND active>0 ORDER BY round_id,leaf_index',[coin.mint])).rows;
  const delivery=[];for(const a of allocations)delivery.push(await D.deliver({...context,mint:coin.mint,round:a.round_id,index:a.leaf_index}));
  await reconcileCoin(db,connection,cfg,coin);return{state:delivery.some(r=>!['finalized','held'].includes(r.state))?'delivering':funded.state,operations,delivery};
 }finally{await releaseOperations(context,coin,round).catch(()=>{});await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[coin.mint]);}
}
async function releaseOperations(context,coin,round){const{connection,cfg}=context;return T.submit({...context,job:'operations:'+coin.mint+':'+round,instructions:[W.operations(cfg.program,coin.mint,cfg.operations)],context:{mint:coin.mint,round,kind:'operations'},readSettlement:async()=>{const c=await accountState(connection,cfg.program,W.addresses(cfg.program,coin.mint).coin,'coin');return c&&(c.lastOperationsCycle>=BigInt(round)||c.operationsPayable===0n)?{settled:true,...c}:{definitivelyUnsettled:true};}});}
async function run({once=false,role=process.env.REWARDS_WORKER_ROLE||'scheduler'}={}){
 const cfg=C.settings(),pool=DB.connect(),connection=new Connection(cfg.rpc,'finalized'),rpc=new I.Rpc(cfg.historyRpc||cfg.rpc),worker=crypto.randomUUID();
 let stopped=false;process.on('SIGTERM',()=>{stopped=true;});process.on('SIGINT',()=>{stopped=true;});
 do{
  // Dedicated session keeps advisory locks on one PostgreSQL connection.
  const db=await pool.connect();try{
   const coins=(await db.query("SELECT * FROM reward_coins WHERE status='active' ORDER BY mint")).rows;
   if(role==='indexer'){
    if(coins.length)await I.indexBatch(db,rpc,{from:Math.min(...coins.map(c=>Number(c.launch_slot))),genesis:cfg.genesis,coins,limit:32});
   }else{
    const preflight=await C.preflight(connection,db,cfg);
    if(!preflight.ready){await DB.audit(db,'worker_held',{blockers:preflight.blockers,mode:cfg.mode});}
    else{
     const payer=await C.keyFromFile('REWARDS_DELIVERY_PAYER_KEY_FILE'),publisher=await C.keyFromFile('REWARDS_PUBLISHER_KEY_FILE',cfg.publisher);
     for(const exit of (await db.query('SELECT mint,wallet FROM reward_disqualifications')).rows)await require('./exits.cjs').publish({db,connection,cfg,preflight,payer},exit.mint,exit.wallet);
     const cutoffSlot=await connection.getSlot('finalized'),time=await connection.getBlockTime(cutoffSlot),round=Math.floor(time/1800);
     for(const coin of coins)await db.query("INSERT INTO reward_jobs(id,mint,kind,due_at) VALUES($1,$2,'cycle',now()) ON CONFLICT DO NOTHING",['cycle:'+coin.mint+':'+round,coin.mint]);
     const job=await DB.leaseJob(db,worker);if(job){const coin=coins.find(c=>c.mint===job.mint);const result=await cycle({db,connection,cfg,preflight,payer,publisher},coin,Number(job.id.split(':').at(-1)));await db.query("UPDATE reward_jobs SET state=$2,checkpoint=$3,due_at=now()+interval '15 seconds',lease_owner=null,lease_until=null WHERE id=$1",[job.id,['completed','reserved','dry-run'].includes(result.state)?'completed':'pending',P.stable(result)]);}
    }
   }
  }catch(e){await DB.audit(db,'worker_error',{role,reason:e.message.replace(/https?:\/\/\S+/g,'[endpoint]')}).catch(()=>{});}finally{db.release();}
  if(!once&&!stopped)await new Promise(resolve=>setTimeout(resolve,3000));
 }while(!once&&!stopped);await pool.end();
}
if(require.main===module)run({once:process.argv.includes('--once')}).catch(()=>{console.error('Worker configuration is incomplete; transfers remain disabled.');process.exitCode=1;});
module.exports={accountState,reconcileCoin,collectFees,creditReceipts,reserveRound,releaseOperations,cycle,run};
