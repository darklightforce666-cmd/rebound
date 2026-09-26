'use strict';
// Durable cycle engine (spec §9, §10). One restartable state machine per (deployment, mint, cycle):
//   scheduled → snapshotting → [waiting_for_data] → awaiting_funding_signature | funding_pending
//   → funded → paying → complete | partially_paid ; or skipped_no_funds / skipped_no_eligible_holders /
//   missed / expired / failed_action_required.
// Guarantees:
//  * Coordination by durable row leases (reward_leases) — safe with the Supabase pooler.
//  * The chain decides timing (program enforces the funding window and the due time); the cutoff
//    never slides; a cycle whose window closed without funding is `missed`/`expired`, and its funds
//    simply stay unallocated for the next valid cycle (never re-split).
//  * Only one unresolved unfunded primary plan per mint (DB unique index); a plan whose deposit
//    transaction is still uncertain is never canceled.
//  * Every transaction goes through transport-v3 (persist before broadcast, reconcile by the
//    program's permanent receipts) under the execution gate.
const DB=require('./db.cjs'),P3=require('./policy-v3.cjs'),S=require('./snapshot-v3.cjs'),W3=require('./wire-v3.cjs');
const T=require('./transport-v3.cjs'),Logs=require('./logs.cjs'),{stable}=require('./policy.cjs');
const b=x=>BigInt(x);
const TERMINAL=new Set(['complete','skipped_no_funds','skipped_no_eligible_holders','missed','expired','failed_action_required']);

async function chainCoin(connection,program,mint){const a=W3.addresses(program,mint);const info=await connection.getAccountInfo(a.coin,'finalized');return info?W3.decode('coin',info.data):null;}
async function chainPaid(connection,program,mint,cycle,index){const a=W3.addresses(program,mint,{cycle,index});const info=await connection.getAccountInfo(a.paid,'finalized');return info?W3.decode('paid',info.data):null;}
async function chainRound(connection,program,mint,cycle){const a=W3.addresses(program,mint,{cycle});const info=await connection.getAccountInfo(a.round,'finalized');return info?W3.decode('round',info.data):null;}
const cycleId=(mint,n)=>`${mint}:${n}`;

// Which cycle's funding window contains time t: cutoff(n) ≤ t < cutoff(n+1).
function openCycle(c,t){const len=Number(c.cycleSeconds),lead=Number(c.cutoffLead),x=Number(t)-Number(c.anchor)+lead;if(x<len)return null;return Math.floor(x/len);}

async function log(db,e){try{await Logs.log(db,{component:'scheduler',...e});}catch{}}
async function setState(db,id,state,fields={},{mint,cycle,message}={}){
 const cols=Object.keys(fields),vals=Object.values(fields);
 await db.query(`UPDATE reward_cycles SET state=$2${cols.map((c,i)=>`,${c}=$${i+3}`).join('')} WHERE id=$1`,[id,state,...vals]);
 await db.query(`INSERT INTO reward_public_cycles(mint,cycle_number,state,cutoff_time,scheduled_end,total_lamports,recipients) SELECT mint,cycle_number,state,cutoff_time,scheduled_end,total_lamports,eligible_count FROM reward_cycles WHERE id=$1
  ON CONFLICT(mint,cycle_number) DO UPDATE SET state=EXCLUDED.state,total_lamports=EXCLUDED.total_lamports,recipients=EXCLUDED.recipients`,[id]);
 await log(db,{severity:['failed_action_required','missed','expired'].includes(state)?'warn':'info',eventType:'cycle_'+state,mint,cycleId:id,message:message||`Cycle ${cycle} → ${state}`});
}

/**
 * ports: {db, connection, program, namespace, feePayer (Keypair), publisher (Keypair),
 *   verifier: {cosign(tx, proposal)} — independent recomputation + partial signature,
 *   inputs(coinRow, cycle, cutoff, cutoffSlot) → S.build inputs (events, coverage, fx, sol, …),
 *   cutoffSlot(t) → slot, now() → finalized unix time, devSigner(coinRow) → Keypair|null,
 *   primaryAwaiting(mint, cutoff) → lamports of dev-wallet holder funding credited ≤ cutoff not yet deposited,
 *   sponsorRent: boolean, worker: string}
 */
async function tick(ports,mint){
 const {db}=ports;
 return DB.withLease(db,'coin:'+mint,ports.worker||'worker',async({renew})=>{
  const coinRow=(await db.query("SELECT * FROM reward_coins WHERE mint=$1 AND program_version='v3'",[mint])).rows[0];if(!coinRow)return{state:'unknown_coin'};
  const c=await chainCoin(ports.connection,ports.program,mint);if(!c||!c.active)return{state:'inactive'};
  // Policy hashes must agree across database, manifest leaves and the on-chain coin.
  const policyHash=(await db.query('SELECT hash FROM reward_policies WHERE version=$1',[coinRow.policy_version])).rows[0]?.hash;
  if(policyHash!==c.policy){await log(db,{severity:'critical',eventType:'policy_mismatch',mint,message:'On-chain coin policy differs from the database policy; settlement refused',errorCode:'POLICY_MISMATCH'});return{state:'failed_action_required',reason:'policy_mismatch'};}
  const t=await ports.now(),n=openCycle(c,t);
  // 1. Resolve every non-terminal cycle first (known funded obligations before new plans).
  const open=(await db.query("SELECT * FROM reward_cycles WHERE mint=$1 AND state NOT IN ('complete','skipped_no_funds','skipped_no_eligible_holders','missed','expired','failed_action_required') ORDER BY cycle_number",[mint])).rows;
  const results=[];for(const row of open){results.push(await advance(ports,coinRow,c,row,t));await renew();}
  // 2. Plan the currently open cycle if it has no row yet and the chain has not funded it.
  if(n&&n>Number(c.lastCycle)&&!(await db.query('SELECT 1 FROM reward_cycles WHERE id=$1',[cycleId(mint,n)])).rows.length){
   const sch=P3.schedule(c.anchor,n,{cycleSeconds:Number(c.cycleSeconds),cutoffLeadSeconds:Number(c.cutoffLead)});
   const blocked=(await db.query("SELECT 1 FROM reward_cycles WHERE mint=$1 AND state IN ('awaiting_funding_signature','funding_pending')",[mint])).rows.length;
   if(!blocked){
    await db.query(`INSERT INTO reward_cycles(id,deployment,mint,cycle_number,namespace,policy_version,config_version,anchor,cycle_start,scheduled_end,cutoff_time,state,due_at,funding_mode)
     VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,'snapshotting',$9,$11) ON CONFLICT DO NOTHING`,
     [cycleId(mint,n),coinRow.deployment,mint,n,coinRow.namespace,coinRow.policy_version,String(c.anchor),String(sch.start),String(sch.end),String(sch.cutoff),c.kind==='primary'?(ports.devSigner&&await ports.devSigner(coinRow)?'automatic':'manual'):'program_treasury']);
    const row=(await db.query('SELECT * FROM reward_cycles WHERE id=$1',[cycleId(mint,n)])).rows[0];
    results.push(await advance(ports,coinRow,c,row,t));
   }else results.push({cycle:n,state:'blocked_by_unresolved_plan'});
  }
  return{state:'ok',now:t,open:n,results};
 },{seconds:120,busy:()=>({state:'busy'})});
}

async function advance(ports,coinRow,c,row,t){
 const {db}=ports,mint=row.mint,n=Number(row.cycle_number),id=row.id,cutoff=Number(row.cutoff_time),due=Number(row.due_at);
 const nextCutoff=cutoff+Number(c.cycleSeconds),ctx={mint,cycle:n};
 switch(row.state){
  case'scheduled':case'snapshotting':case'waiting_for_data':{
   if(t>=nextCutoff){await setState(db,id,'missed',{reason:'funding_window_closed'},{...ctx,message:`Cycle ${n} missed: no valid snapshot before its funding window closed; funds carry forward`});return{cycle:n,state:'missed'};}
   if(t<cutoff)return{cycle:n,state:row.state};
   const slot=await ports.cutoffSlot(cutoff);if(slot==null){await setState(db,id,'waiting_for_data',{reason:'cutoff_slot_unproven'},ctx);return{cycle:n,state:'waiting_for_data'};}
   const onchainH=b(c.holderUnallocated);
   const awaiting=c.kind==='primary'&&ports.primaryAwaiting?b(await ports.primaryAwaiting(mint,cutoff)):0n;
   const inputs=await ports.inputs(coinRow,n,cutoff,slot);
   const snap=S.build({...inputs,mint,cycle:n,cutoff,cutoffSlot:slot,holderReserve:onchainH+awaiting,policy:P3.policy(coinRow.policy_version)});
   if(snap.state==='waiting_for_data'){await setState(db,id,'waiting_for_data',{reason:snap.reason},{...ctx,message:`Cycle ${n} waiting for data: ${snap.reason}`});return{cycle:n,state:'waiting_for_data',reason:snap.reason};}
   await persistSnapshot(db,row,snap,slot);
   if(snap.state!=='ready'){await setState(db,id,snap.state,{},{...ctx,message:`Cycle ${n}: ${snap.state.replaceAll('_',' ')}; unallocated funds carry forward`});return{cycle:n,state:snap.state};}
   const total=b(snap.total),deposit=total>onchainH?total-onchainH:0n;
   if(deposit>0n){
    const signer=ports.devSigner?await ports.devSigner(coinRow):null;
    if(!signer){await prepareManualDeposit(ports,coinRow,c,row,deposit,nextCutoff);return{cycle:n,state:'awaiting_funding_signature',deposit:String(deposit)};}
    await setState(db,id,'funding_pending',{plan_expires_at:String(nextCutoff)},ctx);
    return fundingStep(ports,coinRow,c,{...row,state:'funding_pending'},t,{signer,deposit});
   }
   await setState(db,id,'funding_pending',{plan_expires_at:String(nextCutoff)},ctx);
   return fundingStep(ports,coinRow,c,{...row,state:'funding_pending'},t,{});
  }
  case'awaiting_funding_signature':case'funding_pending':return fundingStep(ports,coinRow,c,row,t,{});
  case'funded':case'paying':case'partially_paid':case'retrying':return t>=due?payStep(ports,coinRow,row):{cycle:n,state:row.state};
  default:return{cycle:n,state:row.state};
 }
}

async function persistSnapshot(db,row,snap,slot){
 await DB.transaction(db,async tx=>{
  await tx.query('UPDATE reward_cycles SET cutoff_slot=$2,snapshot_hash=$3,sol_usd_pico=$4,reference_price_q18=$5,holder_reserve_lamports=$6,budget_lamports=$7,total_lamports=$8,total_loss_usd=$9,eligible_count=$10 WHERE id=$1 AND snapshot_hash IS NULL',
   [row.id,slot,snap.snapshotHash,snap.price?.solUsdPico||null,snap.price?.referenceQ18||null,snap.holderReserve||'0',snap.budget||'0',snap.total||'0',snap.totalLossUsd||'0',snap.awards?.length||0]);
  for(const p of snap.positions)await tx.query('INSERT INTO reward_snapshot_positions(cycle_id,owner,outcome,reason,quantity_raw,cost_usd,value_usd,credit_usd,loss_usd,unrecognized_raw,lots) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING',
   [row.id,p.owner,p.outcome,p.reason,p.quantity,p.costUsd,p.valueUsd,p.creditUsd,p.lossUsd,p.unrecognized,stable(p.lots)]);
  if(snap.state!=='ready')return;
 });
 if(snap.state!=='ready')return;
 // Awards + Merkle manifest (proofs stored with each award).
 const ctx=await manifestContext(db,row);const tr=W3.tree(ctx,snap.awards.map(a=>({index:a.index,wallet:a.owner,amount:a.lamports})));
 const manifest={policy:snap.policyHash,snapshotHash:snap.snapshotHash,cycle:String(row.cycle_number),mint:row.mint,root:{hash:tr.root.hash.toString('hex'),sum:String(tr.root.sum)},awards:tr.awards.map(a=>({index:a.index,wallet:a.wallet,amount:String(a.amount)}))};
 const manifestHash=P3.canonicalHash(manifest);
 await DB.transaction(db,async tx=>{
  for(const [i,a] of snap.awards.entries())await tx.query("INSERT INTO reward_awards(cycle_id,leaf_index,mint,recipient,amount_lamports,credit_usd,lot_credits,proof,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'planned') ON CONFLICT DO NOTHING",
   [row.id,a.index,row.mint,a.owner,a.lamports,a.creditUsd,stable(a.lotCredits),stable(tr.awards[i].proof.map(p=>({hash:p.hash.toString('hex'),sum:String(p.sum)})))]);
  await tx.query('UPDATE reward_cycles SET manifest_hash=$2,root=$3 WHERE id=$1 AND manifest_hash IS NULL',[row.id,manifestHash,tr.root.hash.toString('hex')+':'+String(tr.root.sum)]);
 });
}
async function manifestContext(db,row){const x=(await db.query('SELECT c.policy_version,p.hash FROM reward_cycles c JOIN reward_policies p ON p.version=c.policy_version WHERE c.id=$1',[row.id])).rows[0];return{program:ctxProgram,deployment:ctxDeployment,mint:row.mint,policy:x.hash,cycle:row.cycle_number};}
let ctxProgram=null,ctxDeployment=null;   // set by bind()
function bind(program){ctxProgram=W3.pk(program);ctxDeployment=W3.addresses(program).deployment;}

async function prepareManualDeposit(ports,coinRow,c,row,deposit,expires){
 const {db,connection,program}=ports;const ix=W3.I.depositHolders(program,{fundingWallet:c.fundingWallet,mint:row.mint,amount:deposit});
 const bh=await connection.getLatestBlockhash('confirmed');
 const body={kind:'primary_funding',mint:row.mint,cycle:String(row.cycle_number),amount:String(deposit),baseline:String(c.deposits),signer:c.fundingWallet,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight,
  instruction:{programId:ix.programId.toBase58(),keys:ix.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),data:Buffer.from(ix.data).toString('base64')}};
 const intent=require('node:crypto').randomUUID();
 await db.query("INSERT INTO reward_intents(id,kind,mint,cycle_id,job,namespace,body,body_hash,amount_lamports,signer_role,state) VALUES($1,'primary_funding',$2,$3,$4,$5,$6,$7,$8,'primary_dev','awaiting_signature') ON CONFLICT(kind,job) DO NOTHING",
  [intent,row.mint,row.id,'deposit:'+row.id,coinRow.namespace,stable(body),P3.canonicalHash(body),String(deposit)]);
 await setState(db,row.id,'awaiting_funding_signature',{funding_intent:intent,plan_expires_at:String(expires)},{mint:row.mint,cycle:row.cycle_number,message:`Cycle ${row.cycle_number}: waiting for the dev wallet to sign a holder-only deposit of ${deposit} lamports`});
}

function depositSettlement(ports,mint,expected){
 // A holder deposit is settled when the coin's on-chain `deposits` counter has grown by it.
 return async()=>{const c=await chainCoin(ports.connection,ports.program,mint);return c&&b(c.deposits)>=expected?{settled:true}:{definitivelyUnsettled:true};};
}

async function fundingStep(ports,coinRow,c,row,t,{signer,deposit}){
 row=(await ports.db.query('SELECT * FROM reward_cycles WHERE id=$1',[row.id])).rows[0];   // always the durable row
 const {db,connection,program}=ports,mint=row.mint,n=Number(row.cycle_number),cutoff=Number(row.cutoff_time),nextCutoff=cutoff+Number(c.cycleSeconds);
 const round=await chainRound(connection,program,mint,n);
 if(round){await markFunded(db,row,round);return{cycle:n,state:'funded'};}
 const liveAttempt=(await db.query("SELECT 1 FROM reward_chain_attempts WHERE job LIKE $1 AND state IN ('prepared','broadcast','uncertain')",[`%:${row.id}`])).rows.length>0;
 if(t>=nextCutoff&&!liveAttempt){
  // The program can no longer fund this cycle. Cancel without a compensation credit.
  await db.query("UPDATE reward_awards SET state='released' WHERE cycle_id=$1 AND state='planned'",[row.id]);
  if(row.funding_intent)await db.query("UPDATE reward_intents SET state='expired',updated_at=now() WHERE id=$1",[row.funding_intent]);
  await setState(db,row.id,'expired',{reason:'funding_window_closed'},{mint,cycle:n,message:`Cycle ${n} plan expired unfunded; no compensation credited; funds carry forward`});return{cycle:n,state:'expired'};
 }
 const total=b(row.total_lamports),onchain=b(c.holderUnallocated);
 if(onchain<total){
  const need=total-onchain;
  if(row.state==='awaiting_funding_signature'){
   // The owner signs through the API (submitManualDeposit), which persists and broadcasts the exact bytes.
   const st=(await db.query('SELECT state FROM reward_intents WHERE id=$1',[row.funding_intent])).rows[0]?.state;
   if(st!=='submitted')return{cycle:n,state:'awaiting_funding_signature'};
   await setState(db,row.id,'funding_pending',{},{mint,cycle:n,message:`Cycle ${n}: dev wallet signed the holder deposit; following it on chain`});row={...row,state:'funding_pending'};
  }
  if(row.funding_intent&&!signer){
   // Manual plan the owner already signed: follow that signature only; never sign for the owner.
   const intent=(await db.query('SELECT * FROM reward_intents WHERE id=$1',[row.funding_intent])).rows[0];
   const prior=(await db.query('SELECT * FROM reward_chain_attempts WHERE job=$1 ORDER BY created_at DESC LIMIT 1',['deposit:'+row.id])).rows[0];
   const r=!prior?{state:'expired'}:['prepared','broadcast','uncertain'].includes(prior.state)?await T.reconcile(db,connection,prior,depositSettlement(ports,mint,b(intent.body.baseline)+b(intent.body.amount))):{state:prior.state};
   if(r.state==='expired'||r.state==='failed'){
    await db.query("UPDATE reward_intents SET state='awaiting_signature',updated_at=now() WHERE id=$1",[intent.id]);
    await setState(db,row.id,'awaiting_funding_signature',{},{mint,cycle:n,message:`Cycle ${n}: the signed holder deposit did not land (${r.state}); the dev wallet can sign the plan again`});
    return{cycle:n,state:'awaiting_funding_signature',deposit:r.state};
   }
   if(r.state!=='finalized')return{cycle:n,state:row.state,deposit:r.state};
   return{cycle:n,state:row.state,deposit:'finalized'};   // Fund on the next tick, from fresh on-chain balances
  }
  const dev=signer||(ports.devSigner&&await ports.devSigner(coinRow));if(!dev)return{cycle:n,state:row.state,reason:'dev_signer_unavailable'};
  const baseline=b(c.deposits);
  const r=await T.submit({db,connection,job:'deposit:'+row.id,kind:'primary_funding',signerRole:'primary_dev',feePayer:ports.feePayer,signers:[dev],
   instructions:[W3.I.depositHolders(program,{fundingWallet:dev.publicKey,mint,amount:deposit??need})],readSettlement:depositSettlement(ports,mint,baseline+(deposit??need)),
   spend:{namespace:coinRow.namespace,mint,recipients:[],lamports:String(deposit??need),fees:'5000',cycleId:row.id,kind:'holder_deposit'},context:{cycle:n,amount:String(deposit??need)}});
  if(r.state!=='finalized')return{cycle:n,state:row.state,deposit:r.state,code:r.code};
 }
 // Publisher builds, independent verifier recomputes and co-signs, then Fund.
 const cur=(await db.query('SELECT * FROM reward_cycles WHERE id=$1',[row.id])).rows[0];const [rootHash,rootSum]=cur.root.split(':');
 const count=(await db.query('SELECT count(*)::int n FROM reward_awards WHERE cycle_id=$1',[row.id])).rows[0].n;
 const ix=W3.I.fund(program,{payer:ports.feePayer.publicKey,publisher:ports.publisher.publicKey,verifier:ports.verifierKey,mint,cycle:n,root:{hash:rootHash,sum:rootSum},count,cutoffSlot:cur.cutoff_slot,snapshot:cur.snapshot_hash,manifest:cur.manifest_hash});
 const r=await T.submit({db,connection,job:'fund:'+row.id,kind:'round_fund',signerRole:'publisher',feePayer:ports.feePayer,signers:[ports.publisher],instructions:[ix],
  cosign:tx=>ports.verifier.cosign(tx,{cycleId:row.id,snapshotHash:cur.snapshot_hash,manifestHash:cur.manifest_hash,root:cur.root}),
  readSettlement:async()=>{const rd=await chainRound(connection,program,mint,n);return rd?{settled:true}:{definitivelyUnsettled:true};},
  spend:{namespace:coinRow.namespace,mint,recipients:[],lamports:'0',fees:'10000',cycleId:row.id,kind:'round_fund'},context:{cycle:n}});
 if(r.state==='finalized'){await markFunded(db,row,await chainRound(connection,program,mint,n));return{cycle:n,state:'funded'};}
 if(row.state!=='funding_pending')await setState(db,row.id,'funding_pending',{},{mint,cycle:n});
 return{cycle:n,state:'funding_pending',fund:r.state,code:r.code};
}
async function markFunded(db,row,round){
 await DB.transaction(db,async tx=>{
  const cur=(await tx.query('SELECT * FROM reward_cycles WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(!['funding_pending','awaiting_funding_signature'].includes(cur.state))return;
  if(`${round.root}:${round.total}`!==cur.root)throw Object.assign(Error('On-chain round differs from the stored manifest'),{code:'MANIFEST_MISMATCH'});
  await tx.query("UPDATE reward_awards SET state='reserved' WHERE cycle_id=$1 AND state='planned'",[row.id]);
  await tx.query("UPDATE reward_cycles SET state='funded',funding_signature=COALESCE(funding_signature,'onchain') WHERE id=$1",[row.id]);
 });
 await setState(db,row.id,'funded',{},{mint:row.mint,cycle:row.cycle_number,message:`Cycle ${row.cycle_number} funded on-chain: ${round.total} lamports reserved for ${round.count} holders`});
}

async function payStep(ports,coinRow,row){
 const {db,connection,program}=ports,mint=row.mint,n=Number(row.cycle_number);
 if(row.state==='funded')await setState(db,row.id,'paying',{submitted_at:new Date().toISOString()},{mint,cycle:n});
 const rent=b(await connection.getMinimumBalanceForRentExemption(0));
 const awards=(await db.query("SELECT * FROM reward_awards WHERE cycle_id=$1 AND state IN ('reserved','deferred_rent') ORDER BY leaf_index",[row.id])).rows;
 let pending=0;
 for(const a of awards){
  const onchain=await chainPaid(connection,program,mint,n,a.leaf_index);
  if(onchain){await db.query("UPDATE reward_awards SET state='paid',settled_slot=$3,receipt_address=$4 WHERE cycle_id=$1 AND leaf_index=$2 AND state IN ('reserved','deferred_rent')",[row.id,a.leaf_index,String(onchain.slot),W3.addresses(program,mint,{cycle:n,index:a.leaf_index}).paid.toBase58()]);continue;}
  const exists=await connection.getAccountInfo(W3.pk(a.recipient));const amount=b(a.amount_lamports);
  const needsRent=!exists&&amount<rent;
  if(needsRent&&!ports.sponsorRent){if(a.state!=='deferred_rent')await db.query("UPDATE reward_awards SET state='deferred_rent' WHERE cycle_id=$1 AND leaf_index=$2",[row.id,a.leaf_index]);pending++;continue;}
  const ixs=[];if(needsRent)ixs.push(require('@solana/web3.js').SystemProgram.transfer({fromPubkey:ports.feePayer.publicKey,toPubkey:W3.pk(a.recipient),lamports:Number(rent)}));
  ixs.push(W3.I.pay(program,{payer:ports.feePayer.publicKey,mint,cycle:n,index:a.leaf_index,wallet:a.recipient,amount:a.amount_lamports,proof:a.proof}));
  const r=await T.submit({db,connection,job:`pay:${a.leaf_index}:${row.id}`,kind:'payout',signerRole:'fee_payer',feePayer:ports.feePayer,instructions:ixs,
   readSettlement:async()=>{const p=await chainPaid(connection,program,mint,n,a.leaf_index);return p?{settled:true,slot:Number(p.slot)}:{definitivelyUnsettled:true};},
   spend:{namespace:coinRow.namespace,mint,recipients:[a.recipient],lamports:needsRent?String(rent):'0',fees:'5000',cycleId:row.id,kind:'payout'},context:{cycle:n,index:a.leaf_index}});
  if(r.state==='finalized'){await db.query("UPDATE reward_awards SET state='paid',settlement_signature=$3 WHERE cycle_id=$1 AND leaf_index=$2 AND state IN ('reserved','deferred_rent')",[row.id,a.leaf_index,r.signature||null]);continue;}
  pending++;
 }
 const left=(await db.query("SELECT count(*)::int n, count(*) FILTER (WHERE state='deferred_rent')::int d FROM reward_awards WHERE cycle_id=$1 AND state IN ('reserved','deferred_rent')",[row.id])).rows[0];
 if(left.n===0){await setState(db,row.id,'complete',{finalized_at:new Date().toISOString()},{mint,cycle:n,message:`Cycle ${n} complete: every award paid`});
  await db.query("UPDATE reward_public_tokens SET paid_lamports=(SELECT COALESCE(sum(amount_lamports),0) FROM reward_awards WHERE mint=$1 AND state='paid') WHERE mint=$1",[mint]);return{cycle:n,state:'complete'};}
 const state=left.d===left.n?'partially_paid':'paying';if(state!==row.state)await setState(db,row.id,state,{},{mint,cycle:n,message:`Cycle ${n}: ${left.n} award(s) outstanding (${left.d} waiting for rent-exempt recipient accounts)`});
 return{cycle:n,state,pending:left.n};
}

// ---------------- manual funding (dev wallet signs in the browser) ----------------
function planInstruction(body){const {TransactionInstruction,PublicKey}=require('@solana/web3.js');const i=body.instruction;
 return new TransactionInstruction({programId:new PublicKey(i.programId),keys:i.keys.map(k=>({pubkey:new PublicKey(k.pubkey),isSigner:k.isSigner,isWritable:k.isWritable})),data:Buffer.from(i.data,'base64')});}
async function awaitingPlan(db,mint){
 const row=(await db.query("SELECT * FROM reward_cycles WHERE mint=$1 AND state='awaiting_funding_signature' ORDER BY cycle_number LIMIT 1",[mint])).rows[0];if(!row)return null;
 const intent=(await db.query('SELECT * FROM reward_intents WHERE id=$1',[row.funding_intent])).rows[0];return intent?{row,intent}:null;
}
const ownerOnly=(intent,wallets)=>{if(!wallets.includes(intent.body.signer))throw Object.assign(Error('Only the registered funding wallet can sign this deposit'),{code:'FORBIDDEN'});};
/** The exact holder-only deposit the dev wallet is asked to sign (blockhash refreshed when stale). */
async function manualPlan(ports,{mint,wallets}){
 const {db,connection}=ports;const p=await awaitingPlan(db,mint);if(!p)return null;ownerOnly(p.intent,wallets);
 let body=p.intent.body;
 if(await connection.getBlockHeight('confirmed')>Number(body.lastValidBlockHeight)-20){
  const bh=await connection.getLatestBlockhash('confirmed');body={...body,blockhash:bh.blockhash,lastValidBlockHeight:bh.lastValidBlockHeight};
  await db.query("UPDATE reward_intents SET body=$2,body_hash=$3,updated_at=now() WHERE id=$1 AND state='awaiting_signature'",[p.intent.id,stable(body),P3.canonicalHash(body)]);
 }
 const {Transaction,PublicKey}=require('@solana/web3.js');
 const tx=new Transaction({feePayer:new PublicKey(body.signer),blockhash:body.blockhash,lastValidBlockHeight:body.lastValidBlockHeight}).add(planInstruction(body));
 return{intentId:p.intent.id,cycle:Number(p.row.cycle_number),mint,signer:body.signer,amountLamports:body.amount,holderOnly:true,
  expiresAt:Number(p.row.plan_expires_at),lastValidBlockHeight:body.lastValidBlockHeight,transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')};
}
/** Runs with the API database role: persist + broadcast the owner-signed bytes; the scheduler follows them to Fund. */
async function submitManualDeposit(ports,{mint,intentId,serialized,wallets}){
 const {db,connection}=ports;const p=await awaitingPlan(db,mint);
 if(!p||p.intent.id!==intentId||p.intent.state!=='awaiting_signature')throw Object.assign(Error('This funding plan is no longer awaiting a signature'),{code:'PLAN_STALE'});
 ownerOnly(p.intent,wallets);
 const t=await ports.now();if(t>=Number(p.row.plan_expires_at))throw Object.assign(Error('The funding window for this cycle has closed'),{code:'PLAN_EXPIRED'});
 const body=p.intent.body,coinRow=(await db.query('SELECT namespace FROM reward_coins WHERE mint=$1',[mint])).rows[0];
 const r=await T.submitSigned({db,connection,job:'deposit:'+p.row.id,serialized,
  intent:{id:p.intent.id,instructions:[planInstruction(body)],signer:body.signer,blockhash:body.blockhash,lastValidBlockHeight:body.lastValidBlockHeight},
  readSettlement:depositSettlement(ports,mint,b(body.baseline)+b(body.amount)),
  spend:{namespace:coinRow.namespace,mint,recipients:[],lamports:String(body.amount),fees:'5000',cycleId:p.row.id,kind:'holder_deposit'}});
 if(['submitted','uncertain','finalized'].includes(r.state)){
  await db.query("UPDATE reward_intents SET state='submitted',updated_at=now() WHERE id=$1",[p.intent.id]);   // the scheduler moves the cycle on
  await Logs.log(db,{component:'api',eventType:'holder_deposit_signed',mint,cycleId:p.row.id,message:`Cycle ${p.row.cycle_number}: dev wallet signed the holder-only deposit (${r.state})`,metadata:{signature:r.signature||null}}).catch(()=>{});
 }
 return{state:r.state,signature:r.signature||null,code:r.code||null};
}
module.exports={tick,advance,openCycle,bind,chainCoin,chainRound,chainPaid,TERMINAL,manualPlan,submitManualDeposit};
