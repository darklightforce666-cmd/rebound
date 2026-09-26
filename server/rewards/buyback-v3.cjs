'use strict';
// Third-party 15 % buyback of the PRIMARY mint and a real burn (spec §10.3), durable and resumable:
//   reserve (on chain: budget → per-job buyer PDA; target mint + config version frozen in the job)
//   → quoting (canonical market only; min_out, fees, impact, quote age) → deferred on any failed check
//   → purchase_submitted → purchased_pending_burn (chain job = purchased; spent/acquired from chain)
//   → burn_submitted → burned (supply delta verified by the program) → closed (unspent → reserve).
// A failed/uncertain purchase never re-signs a second buy while the first can still land; a failed
// burn retries only the burn; nothing here can move budget to holders or split it again.
const {ComputeBudgetProgram}=require('@solana/web3.js');
const crypto=require('node:crypto');
const DB=require('./db.cjs'),W3=require('./wire-v3.cjs'),PV=require('./pump-v3.cjs'),T=require('./transport-v3.cjs'),Logs=require('./logs.cjs'),{stable}=require('./policy.cjs');
const {finalizedSuccess}=require('./receipts-v3.cjs');
const b=x=>BigInt(x);
const MIN_BUDGET=()=>BigInt(process.env.REWARDS_MIN_BUYBACK_LAMPORTS||'5000000');
const QUOTE_MAX_AGE_SLOTS=20;

async function chainJob(connection,program,mint,id){const info=await connection.getAccountInfo(W3.addresses(program,mint,{job:id}).job,'finalized');return info?W3.decode('job',info.data):null;}
async function chainCoin(connection,program,mint){const info=await connection.getAccountInfo(W3.addresses(program,mint).coin,'finalized');return info?W3.decode('coin',info.data):null;}
async function deployment(connection,program){const info=await connection.getAccountInfo(W3.addresses(program).deployment,'finalized');return info?W3.decode('deployment',info.data):null;}
const log=(db,e)=>Logs.log(db,{component:'buyback',...e}).catch(()=>{});
async function setJob(db,id,state,fields={}){const cols=Object.keys(fields);await db.query(`UPDATE reward_buyback_jobs SET state=$2${cols.map((c,i)=>`,${c}=$${i+3}`).join('')} WHERE id=$1`,[id,state,...Object.values(fields)]);}

/** Reserve one job per (coin, cycle) when the coin's buyback reserve is worth a purchase. */
async function reserve(ports,coinRow,cycleId){
 const {db,connection,program,feePayer,publisher}=ports,mint=coinRow.mint;
 if((await db.query('SELECT 1 FROM reward_buyback_jobs WHERE source_mint=$1 AND source_cycle_id=$2',[mint,cycleId])).rows.length)return{state:'exists'};
 const open=(await db.query("SELECT 1 FROM reward_buyback_jobs WHERE source_mint=$1 AND state NOT IN ('burned')",[mint])).rows.length;if(open)return{state:'previous_job_open'};
 const [c,d]=await Promise.all([chainCoin(connection,program,mint),deployment(connection,program)]);
 if(!c||!c.active||c.kind!=='third_party')return{state:'inactive'};
 // A reservation that landed after its response was lost (or before a crash) is adopted, never repeated.
 const known=(await db.query('SELECT count(*)::int n FROM reward_buyback_jobs WHERE source_mint=$1',[mint])).rows[0].n;
 if(c.nextJob>BigInt(known)){const j=await chainJob(connection,program,mint,known);if(j)return adopt(db,coinRow,known,j,`${mint}:${j.cycle}`,null);}
 if(!d||d.targetMint===W3.pk('11111111111111111111111111111111').toBase58())return{state:'no_primary_target'};
 const budget=c.buybackAvailable;if(budget<MIN_BUDGET())return{state:'below_minimum',available:String(budget)};
 const p=(await db.query('SELECT buyback_max_slippage_bps s,buyback_max_impact_bps i FROM reward_platform WHERE namespace=$1',[coinRow.namespace])).rows[0];
 const id=c.nextJob,cycle=Number(String(cycleId).split(':').pop());
 const r=await T.submit({db,connection,job:`bb-reserve:${mint}:${id}`,kind:'buyback_purchase',signerRole:'publisher',feePayer,signers:[publisher],
  instructions:[W3.I.reserveBuyback(program,{payer:feePayer.publicKey,publisher:publisher.publicKey,mint,job:id,cycle,amount:budget,maxSlippageBps:p.s,maxImpactBps:p.i})],
  readSettlement:async()=>{const j=await chainJob(connection,program,mint,id);return j?{settled:true,job:j}:{definitivelyUnsettled:true};},
  spend:{namespace:coinRow.namespace,mint,recipients:[],lamports:'0',fees:'5000',kind:'buyback_reserve'},context:{job:id,cycle:cycleId}});
 if(r.state!=='finalized')return{state:r.state,code:r.code};
 return adopt(db,coinRow,id,await chainJob(connection,program,mint,id),cycleId,r.signature||null);
}
async function adopt(db,coinRow,id,j,cycleId,signature){
 const mint=coinRow.mint,rowId=crypto.randomUUID();
 await DB.transaction(db,async t=>{
  await t.query(`INSERT INTO reward_buyback_jobs(id,source_mint,source_cycle_id,target_mint,target_token_program,config_version,budget_lamports,state,max_slippage_bps,max_impact_bps,evidence)
   VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$10) ON CONFLICT DO NOTHING`,[rowId,mint,cycleId,j.targetMint,j.targetTokenProgram,String(j.configVersion),String(j.budget),j.maxSlippageBps,j.maxImpactBps,stable({chainJob:String(id),reserveSignature:signature})]);
  await t.query("INSERT INTO reward_funding_accounts(mint,kind) VALUES($1,'third_party') ON CONFLICT DO NOTHING",[mint]);
  await t.query('UPDATE reward_funding_accounts SET other_available=other_available-$2,other_reserved=other_reserved+$2,version=version+1,updated_at=now() WHERE mint=$1 AND other_available>=$2',[mint,String(j.budget)]);
 });
 await log(db,{eventType:'buyback_reserved',mint,message:`Buyback reserved: ${j.budget} lamports for PRIMARY ${j.targetMint} (config v${j.configVersion}); target frozen for this job`,metadata:{job:String(id)}});
 return{state:'reserved',job:String(id)};
}

/** Advance one open job by at most one on-chain step. */
async function advance(ports,row){
 const {db,connection,program,feePayer,publisher}=ports,mint=row.source_mint,id=Number(row.evidence.chainJob);
 const namespace=(await db.query('SELECT namespace FROM reward_coins WHERE mint=$1',[mint])).rows[0].namespace;
 const j=await chainJob(connection,program,mint,id);if(!j)return{state:row.state,reason:'chain_job_missing'};
 const buyer=W3.addresses(program,mint,{job:id}).buyer;
 // ---- purchase ----
 if(j.state==='reserved'){
  if(row.state==='purchase_submitted'){   // follow the one signed purchase; never sign another while it can land
   const live=(await db.query("SELECT * FROM reward_chain_attempts WHERE job=$1 ORDER BY created_at DESC LIMIT 1",[`bb-swap:${row.id}`])).rows[0];
   if(live&&['prepared','broadcast','uncertain'].includes(live.state)){const r=await T.reconcile(db,connection,live,async()=>{const x=await chainJob(connection,program,mint,id);return x&&x.state!=='reserved'?{settled:true}:{definitivelyUnsettled:true};});if(r.state!=='expired'&&r.state!=='failed')return{state:'purchase_submitted',attempt:r.state};}
   await setJob(db,row.id,'deferred',{reason:'purchase_not_landed'});
  }
  let state;
  try{state=await PV.marketState(connection,j.targetMint,{commitment:'confirmed'});}
  catch(e){await setJob(db,row.id,'deferred',{reason:e.code||'MARKET_UNAVAILABLE'});await log(db,{severity:'warn',eventType:'buyback_deferred',mint,message:`Buyback held: ${e.message}`,errorCode:e.code});return{state:'deferred',reason:e.code};}
  const quotedAt=await connection.getSlot('confirmed');
  let m;try{m=await PV.buybackMarket({connection,payer:feePayer.publicKey,buyer,targetMint:j.targetMint,lamports:j.budget,slippageBps:j.maxSlippageBps,maxImpactBps:j.maxImpactBps,state});}
  catch(e){await setJob(db,row.id,'deferred',{reason:e.code||'QUOTE_FAILED',quote:stable({error:e.message,at:quotedAt})});await log(db,{severity:'warn',eventType:'buyback_deferred',mint,message:`Buyback held, budget stays reserved: ${e.message}`,errorCode:e.code});return{state:'deferred',reason:e.code};}
  const quote={route:state.kind==='curve'?'pump-curve':'pump-amm',market:m.quote.market,expectedOut:String(m.quote.expectedOut),minOut:String(m.quote.minOut),impactBps:m.quote.impactBps,slot:quotedAt,budget:String(j.budget),slippageBps:j.maxSlippageBps};
  await setJob(db,row.id,'quoting',{route:quote.route,market:m.quote.market,inventory_account:m.holding.toBase58(),quote:stable(quote),min_out_raw:String(m.quote.minOut)});
  // Setup (buyer ATAs, protocol WSOL accounts, volume accumulator) is paid by the operations fee payer.
  const s=await T.submit({db,connection,job:`bb-setup:${row.id}:${quote.route}`,kind:'setup',signerRole:'fee_payer',feePayer,signers:[],instructions:m.setup,readSettlement:finalizedSuccess(connection),
   spend:{namespace,mint,recipients:[],lamports:'0',fees:'5000',kind:'buyback_setup'},context:{job:row.id}});
  if(s.state!=='finalized')return{state:'quoting',setup:s.state,code:s.code,reason:s.reason};   // swap only after the setup is final
  if(await connection.getSlot('confirmed')-quotedAt>QUOTE_MAX_AGE_SLOTS)return{state:'quoting',reason:'quote_stale'};   // re-quote next tick
  // The publisher pays this fee itself: one signature keeps the PumpSwap route inside the packet limit.
  const r=await T.submit({db,connection,job:`bb-swap:${row.id}`,kind:'buyback_purchase',signerRole:'publisher',feePayer:publisher,signers:[],
   instructions:[...(state.kind==='curve'?[ComputeBudgetProgram.setComputeUnitLimit({units:600_000})]:[]),W3.I.buybackSwap(program,{publisher:publisher.publicKey,mint,job:id,minOut:m.quote.minOut,market:m.market})],
   readSettlement:async()=>{const x=await chainJob(connection,program,mint,id);return x&&x.state!=='reserved'?{settled:true}:{definitivelyUnsettled:true};},
   spend:{namespace,mint,recipients:[],lamports:String(j.budget),fees:'5000',kind:'buyback_purchase'},context:{job:row.id,quote}});
  if(r.state==='held'||r.state==='blocked'||r.state==='dry_run'){await setJob(db,row.id,'deferred',{reason:r.reason||r.code||r.state});return{state:'deferred',reason:r.reason||r.code};}
  if(r.state!=='finalized'){await setJob(db,row.id,'purchase_submitted',{});return{state:'purchase_submitted',attempt:r.state};}
  return advance(ports,{...row,state:'purchase_submitted'});
 }
 // ---- purchased on chain: record evidence once, then burn only ----
 if(j.state==='purchased'||j.state==='burned'||j.state==='closed'){
  if(!['purchased_pending_burn','burn_submitted','burned'].includes(row.state)){
   const sig=(await db.query("SELECT signature FROM reward_chain_attempts WHERE job=$1 AND state IN ('finalized','uncertain','broadcast') ORDER BY created_at DESC LIMIT 1",[`bb-swap:${row.id}`])).rows[0]?.signature||`chain-job:${id}`;
   await setJob(db,row.id,'purchased_pending_burn',{spent_lamports:String(j.spent),acquired_raw:String(j.acquired),purchase_signature:sig,purchase_slot:String(j.purchaseSlot)});
   await log(db,{eventType:'buyback_purchased',mint,message:`Bought ${j.acquired} raw PRIMARY for ${j.spent} lamports; burning`,metadata:{signature:sig}});
   row={...row,state:'purchased_pending_burn'};
  }
 }
 if(j.state==='purchased'){
  const holding=row.inventory_account?W3.pk(row.inventory_account):require('@solana/spl-token').getAssociatedTokenAddressSync(W3.pk(j.targetMint),buyer,true,W3.pk(j.targetTokenProgram));
  const r=await T.submit({db,connection,job:`bb-burn:${row.id}`,kind:'buyback_burn',signerRole:'fee_payer',feePayer,signers:[],
   instructions:[W3.I.buybackBurn(program,{mint,job:id,holding,targetMint:j.targetMint,tokenProgram:j.targetTokenProgram})],
   readSettlement:async()=>{const x=await chainJob(connection,program,mint,id);return x&&(x.state==='burned'||x.state==='closed')?{settled:true}:{definitivelyUnsettled:true};},
   spend:{namespace,mint,recipients:[],lamports:'0',fees:'5000',kind:'buyback_burn'},context:{job:row.id}});
  if(r.state!=='finalized'){if(row.state!=='burn_submitted'&&['submitted','uncertain'].includes(r.state))await setJob(db,row.id,'burn_submitted',{});return{state:row.state,burn:r.state,code:r.code};}
  return advance(ports,row);
 }
 if(j.state==='burned'||j.state==='closed'){
  if(row.state!=='burned'){
   const sig=(await db.query("SELECT signature FROM reward_chain_attempts WHERE job=$1 ORDER BY created_at DESC LIMIT 1",[`bb-burn:${row.id}`])).rows[0]?.signature||`chain-job:${id}`;
   await setJob(db,row.id,'burned',{burned_raw:String(j.burned),burn_signature:sig,burn_slot:String(j.burnSlot)});
   await log(db,{eventType:'buyback_burned',mint,message:`Burned ${j.burned} raw PRIMARY (finalized; supply reduced on chain)`,metadata:{signature:sig}});
  }
  if(j.state==='burned'){
   const r=await T.submit({db,connection,job:`bb-close:${row.id}`,kind:'buyback_burn',signerRole:'fee_payer',feePayer,signers:[],instructions:[W3.I.closeBuyback(program,{payer:feePayer.publicKey,mint,job:id})],
    readSettlement:async()=>{const x=await chainJob(connection,program,mint,id);return x&&x.state==='closed'?{settled:true}:{definitivelyUnsettled:true};},
    spend:{namespace,mint,recipients:[],lamports:'0',fees:'5000',kind:'buyback_close'},context:{job:row.id}});
   if(r.state!=='finalized')return{state:'burned',close:r.state};
  }
  if(!row.evidence.closed){
   await DB.transaction(db,async t=>{
    const unspent=j.budget-j.spent;
    await t.query('UPDATE reward_funding_accounts SET other_reserved=other_reserved-$2,other_settled=other_settled+$3,other_available=other_available+$4,version=version+1,updated_at=now() WHERE mint=$1',[mint,String(j.budget),String(j.spent),String(unspent)]);
    await t.query("UPDATE reward_buyback_jobs SET evidence=evidence||$2 WHERE id=$1",[row.id,stable({closed:true,unspent:String(unspent)})]);
   });
  }
  return{state:'burned',closed:true};
 }
 return{state:row.state};
}

/** Scheduler entry: reserve for the latest cycle, then advance every open job of the coin. */
async function step(ports,coinRow,cycleId){
 const out={};if(cycleId)out.reserve=await reserve(ports,coinRow,cycleId);
 const rows=(await ports.db.query("SELECT * FROM reward_buyback_jobs WHERE source_mint=$1 AND (state<>'burned' OR NOT (evidence ? 'closed')) ORDER BY created_at",[coinRow.mint])).rows;
 out.jobs=[];for(const r of rows)out.jobs.push(await advance(ports,r));return out;
}
module.exports={reserve,advance,step,chainJob,MIN_BUDGET};
