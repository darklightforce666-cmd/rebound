'use strict';
// REBOUND V3 worker (spec §5.3). One restartable Node process; roles run as independent loops:
//   indexer   — incremental mint-scoped finalized history → reward_events; coverage checkpoints;
//               SOL/USD samples (on-chain Pyth account); verified market heartbeats; dev-wallet
//               funding reconciliation; public token projections.
//   scheduler — cycle-v3 ticks for every active V3 coin.
// Progress is durable in Supabase; a crash loses nothing (leases expire, the next run resumes).
// Netlify functions never run these loops; Supabase Edge Functions are not used as an indexer.
const crypto=require('node:crypto'),bs58=require('bs58');
const {Connection,PublicKey}=require('@solana/web3.js');
const DB=require('./db.cjs'),P3=require('./policy-v3.cjs'),H=require('./history-v3.cjs'),I=require('./indexer.cjs'),Pump=require('./pump.cjs');
const FX=require('./sol-usd.cjs'),F=require('./primary-funding.cjs'),FS=require('./funding-store.cjs'),C=require('./cycle-v3.cjs'),V=require('./verifier-v3.cjs');
const Logs=require('./logs.cjs'),Signer=require('./signer.cjs'),W3=require('./wire-v3.cjs'),{stable}=require('./policy.cjs');
const R=require('./receipts-v3.cjs'),BB=require('./buyback-v3.cjs'),Admin=require('./admin-v3.cjs'),Inbox=require('./key-inbox.cjs'),Direct=require('./cycle-direct.cjs');
const b=x=>BigInt(x);

// ---------------- history ingestion ----------------
// Smarter ingestion (migration 016) — as few RPC requests as possible:
//  * Every pass lists only the mint, its bonding curve and its canonical pool (3 cheap requests): every
//    buy and sell passes through them.
//  * Transfers between wallets are found by reconciliation instead of crawling every wallet: once the
//    queue is empty, one getProgramAccounts returns every current holder's real balance; only accounts
//    whose balance differs from what the ingested history implies have their own history listed.
//    Wallets that sold everything, and holders whose balance already matches, cost nothing.
//  * Each listed signature enters a durable queue once (deduplicated across addresses); each transaction
//    is fetched at most once, in JSON-RPC batches. maxTx bounds one pass; the queue carries the rest.
//  * Coverage is complete only after a reconciliation at or after head found nothing left to fetch.
// If the RPC cannot list holders, it falls back to following every token account seen in history.
async function ingest({db,rpc},coin,{maxTx=Infinity,batch=20,parallel=4,holderCheckSeconds=30}={}){
 const mint=coin.mint,m=H.marketAddresses(mint),head=await rpc.call('getSlot',[{commitment:'finalized'}]);
 const incomplete=[];let newEvents=0,newTx=0,budget=Number.isFinite(maxTx)?Math.max(1,Math.floor(maxTx)):100000;
 for(const [address,role] of [[m.mint,'mint'],[m.curve,'curve'],[m.pool,'pool']])
  await db.query('INSERT INTO reward_history_cursors(mint,address,role,discovered_slot) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[mint,address,role,head]);
 const listInto=async(cur,pre)=>{
  const r=pre||await H.signaturesFor(rpc,cur.address,{until:cur.newest_signature||null});
  if(!r.complete){incomplete.push({address:cur.address,reason:r.reason});return false;}
  const rows=r.signatures.filter(x=>!x.err).map(x=>({signature:x.signature,slot:x.slot,block_index:Number.isInteger(x.transactionIndex)?x.transactionIndex:null}));
  if(rows.length)await db.query(`INSERT INTO reward_history_queue(mint,signature,slot,block_index) SELECT $1,signature,slot,block_index FROM jsonb_to_recordset($2::jsonb) AS x(signature text,slot bigint,block_index int) ON CONFLICT DO NOTHING`,[mint,JSON.stringify(rows)]);
  if(r.signatures.length)await db.query('UPDATE reward_history_cursors SET newest_signature=$3,newest_slot=$4,updated_at=now() WHERE mint=$1 AND address=$2',[mint,cur.address,r.signatures[0].signature,r.signatures[0].slot]);
  return true;
 };
 const blockCache=new Map();
 const blockIndex=async(slot,sig)=>{if(!blockCache.has(slot)){const bl=await rpc.call('getBlock',[slot,{transactionDetails:'signatures',rewards:false,commitment:'finalized',maxSupportedTransactionVersion:H.TX_VERSION}]);blockCache.set(slot,bl?.signatures||[]);}return blockCache.get(slot).indexOf(sig);};
 const fetchChunk=async rows=>{
  const params=rows.map(r=>['getTransaction',[r.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:H.TX_VERSION}]]);
  const txs=typeof rpc.batch==='function'?await rpc.batch(params):await Promise.all(params.map(([mm,pp])=>rpc.call(mm,pp)));
  for(const [i,row] of rows.entries()){
   const tx=txs[i];if(!tx){incomplete.push({signature:row.signature,reason:'transaction_unavailable'});continue;}
   let index=H.reportedIndex(tx,{transactionIndex:row.block_index??undefined});if(index==null)index=await blockIndex(tx.slot,row.signature);
   if(index<0){incomplete.push({slot:tx.slot,reason:'in_block_order_unavailable'});continue;}
   const parsed=I.parseTransaction(tx,{slot:tx.slot,time:tx.blockTime,transactionIndex:index,coins:[{mint,intake:coin.intake,sharing_config:coin.sharing_config,current_creator:null}]});
   await DB.transaction(db,async t=>{
    for(const e of parsed.events)await t.query('INSERT INTO reward_events(id,mint,signature,instruction_path,event_index,slot,transaction_index,execution_order,kind,owner,data,raw_digest,parser_version,finalized) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true) ON CONFLICT DO NOTHING',
     [e.id,e.mint,e.signature,e.path,e.eventIndex,e.slot,index,e.order,e.kind,e.owner,stable({...e.data,time:tx.blockTime}),e.rawDigest,I.PARSER]);
    if(parsed.holds.length)await t.query("INSERT INTO reward_audit(kind,mint,actor,evidence) VALUES('parser_hold',$1,'indexer',$2)",[mint,stable({signature:row.signature,holds:parsed.holds})]);
    await t.query('UPDATE reward_history_queue SET fetched_at=now(),events=$3 WHERE mint=$1 AND signature=$2',[mint,row.signature,parsed.events.length]);
   },{serializable:false});
   newEvents+=parsed.events.length;newTx++;
  }
 };
 const fetchPending=async()=>{
  // Transactions already ingested by an earlier version are never fetched again.
  await db.query('UPDATE reward_history_queue q SET fetched_at=now(),events=0 WHERE q.mint=$1 AND q.fetched_at IS NULL AND EXISTS(SELECT 1 FROM reward_events e WHERE e.signature=q.signature)',[mint]);
  if(budget<=0)return;
  const rows=(await db.query('SELECT signature,slot,block_index FROM reward_history_queue WHERE mint=$1 AND fetched_at IS NULL ORDER BY slot,signature LIMIT $2',[mint,budget])).rows;budget-=rows.length;
  const chunks=[];for(let i=0;i<rows.length;i+=batch)chunks.push(rows.slice(i,i+batch));
  for(let i=0;i<chunks.length;i+=parallel)await Promise.all(chunks.slice(i,i+parallel).map(fetchChunk));
 };
 const pendingCount=async()=>(await db.query('SELECT count(*)::int n FROM reward_history_queue WHERE mint=$1 AND fetched_at IS NULL',[mint])).rows[0].n;
 // 1. Trades: the three market addresses, every pass.
 for(const cur of (await db.query("SELECT * FROM reward_history_cursors WHERE mint=$1 AND role IN ('mint','curve','pool')",[mint])).rows)await listInto(cur);
 await fetchPending();
 // 2. Transfers: reconcile real holder balances with the history, once nothing is pending.
 let hc=(await db.query('SELECT * FROM reward_checkpoints WHERE name=$1',['holders:'+mint])).rows[0],holders=null,mismatched=null,holderError=null;
 // Due when never done, incomplete, or a round's snapshot time passed since the last reconciliation
 // (so each snapshot has one right after it). holderCheckSeconds is a floor between checks.
 const nowS=Math.floor(Date.now()/1000),anchor=Number(coin.schedule_anchor||0),len=Number(coin.cycle_seconds||0),lead=Number(coin.cutoff_lead_seconds||0);
 let lastCutoff=0;if(anchor&&len){const n=Math.floor((nowS-anchor)/len)+1;lastCutoff=anchor+n*len-lead;if(lastCutoff>nowS)lastCutoff-=len;}
 const since=hc?Math.floor(new Date(hc.updated_at).getTime()/1000):0;
 const due=!hc||!hc.complete||(lastCutoff&&Number(hc.through_time||0)<lastCutoff&&nowS-since>=5)||(!anchor&&nowS-since>=holderCheckSeconds);
 if(await pendingCount()===0&&due){
  try{holders=await H.currentHolderAccounts(rpc,mint);}catch(e){holderError=String(e.message||e).slice(0,120);}
  let ok=false,slot=head;
  if(holders){
   slot=holders.slot??head;
   const known=new Map((await db.query(`SELECT DISTINCT ON (a->>'account') a->>'account' AS account, a->>'amount' AS amount FROM reward_events e, jsonb_array_elements(e.data->'accounts') a
    WHERE e.mint=$1 AND e.kind='token_balances' ORDER BY a->>'account', e.slot DESC, e.transaction_index DESC, e.execution_order DESC`,[mint])).rows.map(r=>[r.account,r.amount]));
   const diff=holders.accounts.filter(h=>known.get(h.account)!==h.amount);mismatched=diff.length;ok=true;
   for(const h of diff)await db.query("INSERT INTO reward_history_cursors(mint,address,role,discovered_slot) VALUES($1,$2,'token_account',$3) ON CONFLICT DO NOTHING",[mint,h.account,slot]);
   const curs=diff.length?(await db.query('SELECT * FROM reward_history_cursors WHERE mint=$1 AND address=ANY($2::text[])',[mint,diff.map(h=>h.account)])).rows:[];
   const lists=await H.signaturesForMany(rpc,curs.map(c=>({address:c.address,until:c.newest_signature||null})));
   for(const cur of curs)if(!await listInto(cur,lists.get(cur.address)))ok=false;
   await fetchPending();if(await pendingCount()>0)ok=false;
  }else{
   // Fallback: follow every token account ever seen in the history (more requests, same result),
   // repeating while new accounts appear.
   for(let round=0;round<5;round++){
    const added=(await db.query(`INSERT INTO reward_history_cursors(mint,address,role,discovered_slot)
     SELECT DISTINCT $1,a->>'account','token_account',e.slot FROM reward_events e, jsonb_array_elements(e.data->'accounts') a WHERE e.mint=$1 AND e.kind='token_balances' ON CONFLICT DO NOTHING RETURNING address`,[mint])).rows.length;
    if(round>0&&!added)break;
    const curs=(await db.query("SELECT * FROM reward_history_cursors WHERE mint=$1 AND role='token_account'",[mint])).rows;
    const lists=await H.signaturesForMany(rpc,curs.map(c=>({address:c.address,until:c.newest_signature||null})));
    for(const cur of curs)await listInto(cur,lists.get(cur.address));
    await fetchPending();if(budget<=0)break;
   }
   ok=(await pendingCount())===0&&!incomplete.length;
  }
  await db.query(`INSERT INTO reward_checkpoints(name,through_slot,through_time,start_slot,complete,parser_version,digest,incident) VALUES($1,$2,$3,$2,$4,$5,'',$6)
   ON CONFLICT(name) DO UPDATE SET through_slot=EXCLUDED.through_slot,through_time=EXCLUDED.through_time,complete=EXCLUDED.complete,incident=EXCLUDED.incident,updated_at=now()`,
   ['holders:'+mint,slot,await rpc.call('getBlockTime',[slot]),ok,I.PARSER,stable({holders:holders?holders.accounts.length:null,mismatched,fallback:!holders,error:holderError})]);
  hc=(await db.query('SELECT * FROM reward_checkpoints WHERE name=$1',['holders:'+mint])).rows[0];
 }
 // 3. Coverage: through the older of the market listing (head) and the last complete reconciliation.
 const q=(await db.query('SELECT count(*)::int total, count(*) FILTER (WHERE fetched_at IS NOT NULL)::int fetched FROM reward_history_queue WHERE mint=$1',[mint])).rows[0];
 if(q.total>q.fetched)incomplete.push({reason:'continues_next_pass',pending:q.total-q.fetched});
 if(!hc?.complete)incomplete.push({reason:'holder_reconciliation_pending'});
 const complete=incomplete.length===0,through=complete?Math.min(head,Number(hc.through_slot)):head;
 await db.query(`INSERT INTO reward_checkpoints(name,through_slot,through_time,start_slot,complete,parser_version,digest,incident) VALUES($1,$2,$3,$2,$4,$5,'',$6)
  ON CONFLICT(name) DO UPDATE SET through_slot=CASE WHEN EXCLUDED.complete THEN EXCLUDED.through_slot ELSE reward_checkpoints.through_slot END,through_time=CASE WHEN EXCLUDED.complete THEN EXCLUDED.through_time ELSE reward_checkpoints.through_time END,complete=EXCLUDED.complete,incident=EXCLUDED.incident,updated_at=now()`,
  ['history:'+mint,through,await rpc.call('getBlockTime',[through]),complete,I.PARSER,complete?null:stable({incomplete:incomplete.slice(0,20)})]);
 await db.query('UPDATE reward_public_tokens SET history_fetched=$2,history_total=$3,history_complete=$4 WHERE mint=$1',[mint,q.fetched,q.total,complete]).catch(()=>{});
 const inc=hc?.incident||{};
 return{head,newTx,newEvents,complete,incomplete,holders:inc.holders??null,mismatched:inc.mismatched??null,fallback:!!inc.fallback,holderError:inc.error||null,fetched:q.fetched,total:q.total};
}

// ---------------- evidence loaders for snapshots (scheduler and verifier use the same code) ----------------
// Compensation already reserved or paid before this cutoff, per lot (reduces remaining losses).
async function loadCredits(db,mint,cutoffSlot){
 return(await db.query(`SELECT lc.lot_id,lc.credit_usd,a.state,c.cutoff_slot,a.cycle_id,a.leaf_index FROM reward_lot_credits lc JOIN reward_awards a USING(cycle_id,leaf_index) JOIN reward_cycles c ON c.id=a.cycle_id
   WHERE a.mint=$1 AND a.state IN ('reserved','paid','deferred_rent') AND c.cutoff_slot<$2`,[mint,cutoffSlot])).rows.map(r=>({slot:Number(r.cutoff_slot),lotId:r.lot_id,credit:b(r.credit_usd),state:r.state==='paid'?'paid':'reserved',award:r.cycle_id+':'+r.leaf_index}));
}
function inputsLoader(db){
 return async(coinRow,cycle,cutoff,cutoffSlot)=>{
  const mint=coinRow.mint,m=H.marketAddresses(mint);
  const rows=(await db.query('SELECT * FROM reward_events WHERE mint=$1 AND slot<=$2 ORDER BY slot,transaction_index,execution_order,event_index',[mint,cutoffSlot])).rows;
  const events=rows.map(e=>({id:e.id,mint:e.mint,signature:e.signature,path:e.instruction_path,eventIndex:e.event_index,slot:Number(e.slot),transactionIndex:e.transaction_index,order:e.execution_order,kind:e.kind,owner:e.owner,data:e.data,time:Number(e.data.time)}));
  const cp=(await db.query('SELECT * FROM reward_checkpoints WHERE name=$1',['history:'+mint])).rows[0];
  const holds=(await db.query("SELECT evidence FROM reward_audit WHERE kind='parser_hold' AND mint=$1",[mint])).rows.flatMap(r=>r.evidence.holds||[]);
  const purchaseTimes=events.filter(e=>e.kind==='purchase_candidate').map(e=>e.time);
  const minT=purchaseTimes.length?Math.min(...purchaseTimes)-60:cutoff-120;
  const series=await FX.load(db,minT,cutoff);
  const excluded=new Set([m.curve,m.pool,m.poolAuthority,...[coinRow.intake,coinRow.treasury].filter(Boolean)]);
  const credits=await loadCredits(db,mint,cutoffSlot);
  const heartbeats=(await db.query('SELECT observed_at,quote_model,base_reserve,real_quote,virtual_quote,market FROM reward_price_observations WHERE mint=$1 AND heartbeat AND observed_at BETWEEN $2 AND $3',[mint,cutoff-120,cutoff])).rows
   .map(r=>({time:Number(r.observed_at),market:r.quote_model==='curve'?'pump-curve':'pump-amm:'+r.market,s18:r.quote_model==='curve'?P3.curveS18({virtualSolReserves:r.virtual_quote,virtualTokenReserves:r.base_reserve}):P3.ammS18({quoteReserve:r.real_quote,baseReserve:r.base_reserve})}));
  return{events,parserHolds:holds,coverage:{complete:!!cp?.complete,throughSlot:cp?Number(cp.through_slot):0},excluded,fx:FX.lookup(series),solSeries:series,heartbeats,credits};
 };
}

// ---------------- samplers ----------------
// Live SOL/USD sample: Hermes when PYTH_API_KEY is configured (fresh), otherwise the on-chain Pyth account.
async function sampleSolUsd({db,connection,hermes=FX.hermesLatest}){
 let o=null;try{o=await hermes();}catch(e){if(Date.now()-(sampleSolUsd.warned||0)>300000){sampleSolUsd.warned=Date.now();await Logs.log(db,{severity:'warn',component:'indexer',eventType:'sol_usd_hermes_failed',message:e.message+' (falling back to the on-chain feed)',errorCode:e.code});}}
 if(!o)o=await FX.onchainAt(connection,process.env.PYTH_SOL_USD_ACCOUNT||FX.DEFAULT_FEED_ACCOUNT);
 if(o)await FX.persist(db,o);return o;
}
// Historical SOL/USD for purchases that have no valid sample (bought before sampling started, or
// between ~53 s on-chain updates). Needs PYTH_API_KEY (Benchmarks); bounded per loop.
async function backfillSolUsd({db,at=FX.hermesAt,configured=FX.hermesConfig().configured,limit=20},mint){
 if(!configured)return 0;const age=P3.POLICY.solUsd.maxAgeSeconds;
 const times=(await db.query(`SELECT DISTINCT (e.data->>'time')::bigint AS t FROM reward_events e WHERE e.mint=$1 AND e.kind='purchase_candidate'
   AND NOT EXISTS(SELECT 1 FROM reward_sol_usd s WHERE s.feed_id=$2 AND s.publish_time BETWEEN (e.data->>'time')::bigint-$3 AND (e.data->>'time')::bigint) ORDER BY 1 LIMIT 1000`,[mint,FX.FEED,age])).rows.map(r=>Number(r.t));
 const tried=backfillSolUsd.tried||(backfillSolUsd.tried=new Map()),now=Date.now();   // times without data are retried at most every 10 min
 let n=0;for(const t of times.filter(t=>!(now-(tried.get(t)||0)<600000)).slice(0,limit)){tried.set(t,now);const list=await at(t,{window:age});const o=list[list.length-1];if(o){await FX.persist(db,o);tried.delete(t);n++;}}
 if(tried.size>10000)tried.clear();
 return n;
}
async function heartbeat({db,connection},coin){
 const mint=new PublicKey(coin.mint),curve=Pump.SDK.bondingCurvePda(mint);const r=await connection.getAccountInfoAndContext(curve,'finalized');if(!r.value)return null;
 const bc=Pump.sdk.decodeBondingCurve(r.value);const time=await connection.getBlockTime(r.context.slot);
 if(!bc.complete){await db.query("INSERT INTO reward_price_observations(mint,slot,observed_at,market,base_reserve,real_quote,virtual_quote,evidence,quote_model,block_time,heartbeat) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'curve',$3,true) ON CONFLICT DO NOTHING",
  [coin.mint,r.context.slot,time,curve.toBase58(),bc.virtualTokenReserves.toString(),(bc.realQuoteReserves??bc.realSolReserves).toString(),(bc.virtualQuoteReserves??bc.virtualSolReserves).toString(),stable({source:'bonding_curve_account',slot:r.context.slot})]);return{market:'curve',slot:r.context.slot};}
 const pool=Pump.SDK.canonicalPumpPoolPda(mint);const p=await connection.getAccountInfo(pool,'finalized');if(!p)return null;
 const state=Pump.SDK.getPumpAmmProgram(connection).coder.accounts.decode('pool',p.data);
 const [base,quote]=await Promise.all([connection.getTokenAccountBalance(state.poolBaseTokenAccount,'finalized'),connection.getTokenAccountBalance(state.poolQuoteTokenAccount,'finalized')]);
 await db.query("INSERT INTO reward_price_observations(mint,slot,observed_at,market,base_reserve,real_quote,virtual_quote,evidence,quote_model,block_time,heartbeat) VALUES($1,$2,$3,$4,$5,$6,0,$7,'amm',$3,true) ON CONFLICT DO NOTHING",
  [coin.mint,base.context.slot,await connection.getBlockTime(base.context.slot),pool.toBase58(),base.value.amount,quote.value.amount,stable({source:'canonical_pool_balances'})]);return{market:'amm'};
}
// A REBOUND holder deposit is recognized from the finalized transaction itself: a top-level
// DepositHolders instruction of this program, signed by the dev wallet, into this coin's account.
// Database rows (which the API role can write) never decide what counts as a deposit.
function chainDeposit(tx,{program,wallet,coin}){
 let total=0n,found=false;
 for(const ix of tx.transaction.message.instructions||[]){
  if(String(ix.programId)!==program||typeof ix.data!=='string'||!Array.isArray(ix.accounts))continue;
  let d;try{d=Buffer.from(bs58.decode(ix.data));}catch{continue;}
  if(d.length!==9||d[0]!==W3.TAG.DepositHolders||String(ix.accounts[0])!==wallet||String(ix.accounts[2])!==coin)continue;
  total+=d.readBigUInt64LE(1);found=true;
 }
 return found?{kind:'holder_deposit',amount:String(total)}:null;
}
// Dev-wallet reconciliation (scheduler: the only role that writes funding ledgers). Transactions are
// applied oldest first; reconciliation never advances past a transaction it could not read, and a
// partial signature listing is not applied at all.
async function reconcileFunding({db,rpc,program},coin){
 const fw=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[coin.mint])).rows[0];if(!fw||fw.opening_slot==null||fw.funding_model==='balance_budget')return null;   // budget wallets are not an income ledger
 const r=await H.signaturesFor(rpc,fw.address,{until:fw.reconciled_signature||null});
 if(!r.complete)return{credits:0,incidents:0,gap:r.reason||'incomplete'};
 const ctx=program?{program:program.toBase58(),wallet:fw.address,coin:W3.addresses(program,new PublicKey(coin.mint)).coin.toBase58()}:null;
 const classified=[];let last=null,gap=null;
 for(const s of r.signatures.slice().reverse()){
  const tx=await rpc.call('getTransaction',[s.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:H.TX_VERSION}]);
  if(!tx){gap=s.signature;break;}
  const intent=ctx?chainDeposit(tx,ctx):null;
  classified.push(F.classify(tx,fw.address,new Map(intent?[[s.signature,intent]]:[])));last=s.signature;
 }
 const out=await FS.applyWalletTransactions(db,{mint:coin.mint,wallet:fw.address,classified});
 if(last)await db.query('UPDATE reward_funding_wallets SET reconciled_signature=$2 WHERE id=$1',[fw.id,last]);
 return{credits:out.credits.length,incidents:out.incidents.length,...(gap?{gap}:{})};
}
// Holder funding (dev wallet, primary) credited at or before `cutoff` and not yet deposited.
async function primaryAwaiting(db,mint,cutoff){
 const a=(await db.query('SELECT holder_awaiting_transfer FROM reward_funding_accounts WHERE mint=$1',[mint])).rows[0];if(!a)return 0n;
 const late=(await db.query('SELECT COALESCE(sum(holder_lamports),0) s FROM reward_funding_credits WHERE mint=$1 AND block_time>$2',[mint,cutoff])).rows[0].s;
 const v=b(a.holder_awaiting_transfer)-b(String(late).split('.')[0]);return v>0n?v:0n;
}
// ---------------- balance budget (funding_model = 'balance_budget') ----------------
// The admin commits budget_bps of the fee wallet's CURRENT balance. The scheduler measures that
// balance once (finalized) and fixes budget_lamports plus the coin's on-chain deposit counter at that
// moment; usage afterwards is read from the chain (Coin.deposits), never from database rows.
const BUDGET_FEE_RESERVE=10_000_000n;   // keep 0.01 SOL in the fee wallet
async function applyBudgetRequests(db,{connection,program}){
 const rows=(await db.query("SELECT *,budget_requested_at::text AS requested_text FROM reward_funding_wallets WHERE status<>'retired' AND funding_model='balance_budget' AND budget_requested_at IS NOT NULL AND (budget_set_at IS NULL OR budget_set_at<budget_requested_at)")).rows;const out=[];
 for(const fw of rows){
  const bal=await connection.getBalanceAndContext(new PublicKey(fw.address),'finalized');
  const info=program?await connection.getAccountInfo(W3.addresses(program,new PublicKey(fw.mint)).coin,'finalized'):null;
  const deposits=info&&program&&info.owner.equals(program)?b(W3.decode('coin',info.data).deposits):0n;
  // Money already owed to holders (reserved, not yet paid) is not part of the balance being committed.
  const owed=await Direct.unpaidOf(db,fw.id),free=b(bal.value)>owed?b(bal.value)-owed:0n;
  const budget=free*BigInt(fw.budget_bps)/10000n;
  // Guarded: a request the admin made meanwhile (e.g. a lower percentage) is never marked as satisfied here.
  const u=await db.query('UPDATE reward_funding_wallets SET budget_balance_lamports=$2,budget_lamports=$3,budget_start_deposits=$4,budget_set_at=greatest(now(),budget_requested_at) WHERE id=$1 AND budget_bps=$5 AND budget_requested_at::text=$6',[fw.id,String(free),String(budget),String(deposits),fw.budget_bps,fw.requested_text]);
  if(!(u.rowCount??u.affectedRows))continue;
  await Logs.log(db,{severity:'warn',component:'scheduler',eventType:'funding_budget_set',mint:fw.mint,message:`Holder budget fixed: ${budget} lamports = ${fw.budget_bps/100}% of the fee wallet balance ${bal.value} (finalized slot ${bal.context.slot}); rounds deposit only what is left of it`,metadata:{wallet:fw.address,budget:String(budget),balance:String(bal.value),startDeposits:String(deposits)}});
  out.push({mint:fw.mint,budget:String(budget)});
 }
 return out;
}
// Lamports the next round may still take from a budget wallet; null for an income-ledger wallet.
async function budgetAvailable(db,connection,mint,chainCoin){
 const fw=(await db.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired'",[mint])).rows[0];
 if(!fw||fw.funding_model!=='balance_budget')return null;
 if(!fw.budget_set_at||(fw.budget_requested_at&&new Date(fw.budget_set_at)<new Date(fw.budget_requested_at)))return 0n;   // not measured yet
 const used=b(chainCoin?.deposits??0)-b(fw.budget_start_deposits??0);
 // A percentage lowered after measurement applies at once: budget = min(fixed, measured balance × current %).
 const lowered=b(fw.budget_balance_lamports??0)*BigInt(fw.budget_bps)/10000n,budget=lowered<b(fw.budget_lamports)?lowered:b(fw.budget_lamports);
 const left=budget-(used>0n?used:0n);if(left<=0n)return 0n;
 const bal=b(await connection.getBalance(new PublicKey(fw.address),'finalized'))-BUDGET_FEE_RESERVE;
 const v=left<bal?left:bal;return v>0n?v:0n;
}
async function projectToken({db,connection},coin){
 const info=await connection.getParsedAccountInfo(new PublicKey(coin.mint),'finalized');const m=info.value?.data?.parsed?.info;if(!m)return;
 const obs=(await db.query('SELECT * FROM reward_price_observations WHERE mint=$1 ORDER BY observed_at DESC LIMIT 1',[coin.mint])).rows[0];
 const sol=(await db.query('SELECT * FROM reward_sol_usd ORDER BY publish_time DESC LIMIT 1')).rows[0];
 let price=null,cap=null,at=null;
 if(obs&&sol){const s18=obs.quote_model==='curve'?P3.curveS18({virtualSolReserves:obs.virtual_quote,virtualTokenReserves:obs.base_reserve}):P3.ammS18({quoteReserve:obs.real_quote,baseReserve:obs.base_reserve});
  if(s18){const q18=s18*b(sol.price_usd_pico)/P3.LAMPORTS;price=q18/P3.E18;cap=b(m.supply)*q18/P3.E18;at=new Date(Number(obs.observed_at)*1000).toISOString();}}
 const status=coin.status==='active'?'active':coin.status;
 await db.query(`INSERT INTO reward_public_tokens(mint,namespace,kind,name,symbol,image_uri,creator_wallet,launch_time,decimals,supply_definition,supply_raw,price_usd_pico,price_updated_at,market_cap_usd_pico,market_cap_kind,price_source,reward_status,pinned,test)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'outstanding mint supply (burned units excluded)',$10,$11,$12,$13,'market_cap',$14,$15,$16,$17)
  ON CONFLICT(mint) DO UPDATE SET name=EXCLUDED.name,symbol=EXCLUDED.symbol,image_uri=EXCLUDED.image_uri,decimals=EXCLUDED.decimals,supply_raw=EXCLUDED.supply_raw,price_usd_pico=COALESCE(EXCLUDED.price_usd_pico,reward_public_tokens.price_usd_pico),
   price_updated_at=COALESCE(EXCLUDED.price_updated_at,reward_public_tokens.price_updated_at),market_cap_usd_pico=COALESCE(EXCLUDED.market_cap_usd_pico,reward_public_tokens.market_cap_usd_pico),reward_status=EXCLUDED.reward_status`,
  [coin.mint,coin.namespace,coin.kind,coin.name,coin.symbol,coin.image_uri,coin.creator_wallet,coin.launch_time,m.decimals,m.supply,price==null?null:String(price),at,cap==null?null:String(cap),obs?(obs.quote_model==='curve'?'pump bonding curve (finalized)':'canonical PumpSwap pool (finalized)'):null,status,coin.kind==='primary',coin.namespace==='mainnet_test']);
}

// ---------------- process ----------------
// Signing preflight: the scheduler signs nothing unless the chain it talks to is the configured
// network and the on-chain deployment names exactly this worker's publisher/verifier keys and a
// known policy. Re-checked every loop (one account read), so a key rotation or a wrong RPC stops
// settlement instead of producing rejected transactions.
const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
async function preflightV3({connection,program,publisher,verifier,genesis=process.env.REWARDS_GENESIS_HASH||MAINNET_GENESIS}){
 const got=await connection.getGenesisHash();if(got!==genesis)return{ok:false,reason:`wrong network (genesis ${got})`};
 const info=await connection.getAccountInfo(W3.addresses(program).deployment,'finalized');
 if(!info||!info.owner.equals(program))return{ok:false,reason:'deployment not initialized by this program'};
 const d=W3.decode('deployment',info.data);
 if(d.publisher!==publisher.toBase58())return{ok:false,reason:'publisher key does not match the deployment'};
 if(d.verifier!==verifier.toBase58())return{ok:false,reason:'verifier key does not match the deployment'};
 const expected=d.testMode?P3.hashOf(P3.TEST_POLICY):P3.POLICY_HASH;if(d.policy!==expected)return{ok:false,reason:'deployment policy is not the published '+(d.testMode?'test':'production')+' policy'};
 return{ok:true,testMode:d.testMode,paused:d.paused};
}
// DATABASE_URL-style values may come from files mounted as secrets (NAME_FILE).
function envOrFile(name){if(process.env[name])return process.env[name];const f=process.env[name+'_FILE'];return f?require('node:fs').readFileSync(f,'utf8').trim():undefined;}

async function main({role=process.env.REWARDS_WORKER_ROLE||'all',once=process.argv.includes('--once')}={}){
 const host=(()=>{try{return require('node:os').hostname();}catch{return 'hosted';}})(),worker=`worker:${host}:${process.pid||0}:${crypto.randomUUID().slice(0,8)}`;
 const rpcUrl=process.env.SOLANA_RPC_URL,historyUrl=process.env.HISTORY_RPC_URL||rpcUrl;if(!rpcUrl)throw Object.assign(Error('SOLANA_RPC_URL is required'),{code:'SETUP_REQUIRED'});
 const connection=new Connection(rpcUrl,'finalized'),rpc=new H.Rpc(historyUrl,{minIntervalMs:Number(process.env.HISTORY_RPC_MIN_INTERVAL_MS||100)});
 const asRole=r=>process.env.REWARDS_DB_SET_ROLE==='true'?r:null;   // hosted worker: one URL, per-role privileges
 const idb=role!=='scheduler'?DB.connect(envOrFile('INDEXER_DATABASE_URL')||envOrFile('DATABASE_URL'),{max:2,name:'rebound-indexer',role:asRole('rebound_indexer')}):null;
 const settles=role==='all'||role==='scheduler';   // an indexer-only process holds no scheduler/verifier connection
 const sdb=settles?DB.connect(envOrFile('SCHEDULER_DATABASE_URL')||envOrFile('DATABASE_URL'),{max:2,name:'rebound-scheduler',role:asRole('rebound_scheduler')}):null;
 const vdb=settles?DB.connect(envOrFile('VERIFIER_DATABASE_URL')||envOrFile('DATABASE_URL'),{max:1,name:'rebound-verifier',role:asRole('rebound_verifier')}):null;
 // A pool that should run as a REBOUND group role must really do so (a pooler could drop the startup option).
 if(process.env.REWARDS_DB_SET_ROLE==='true')for(const [pool,want] of [[idb,'rebound_indexer'],[sdb,'rebound_scheduler'],[vdb,'rebound_verifier']])if(pool){
  const who=(await pool.query('SELECT current_user AS u')).rows[0].u;if(who!==want){await Promise.all([idb,sdb,vdb].filter(Boolean).map(p=>p.end()));throw Object.assign(Error(`Database role not applied (running as ${who}); refusing to work without per-role privileges`),{code:'DB_ROLE'});}}
 let stop=false;for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{stop=true;});
 const program=process.env.REWARDS_PROGRAM_ID?new PublicKey(process.env.REWARDS_PROGRAM_ID):null;if(program)C.bind(program);
 const keyFile=async(env,expected)=>{if(!process.env[env])return null;const k=await require('./config.cjs').keyFromFile(env,expected);return k;};
 const feePayer=program?await keyFile('REWARDS_FEE_PAYER_KEY_FILE',process.env.REWARDS_FEE_PAYER_ADDRESS):null;
 const publisher=program?await keyFile('REWARDS_PUBLISHER_KEY_FILE',process.env.REWARDS_PUBLISHER_ADDRESS):null;
 const verifierKey=program?await keyFile('REWARDS_VERIFIER_KEY_FILE',process.env.REWARDS_VERIFIER_ADDRESS):null;
 const inputs=inputsLoader(idb||sdb);let checked={ok:false,reason:'not checked',at:0};
 do{
  const started=Date.now();
  try{
   const cdb=role==='scheduler'?sdb:idb;   // each process only uses its own database login
   const coins=(await cdb.query("SELECT * FROM reward_coins WHERE program_version='v3' AND status IN ('registered','indexing','ready','active','activating','created_pending_activation','paused')")).rows;
   if(role==='all'||role==='indexer'){
    await sampleSolUsd({db:idb,connection}).catch(e=>Logs.log(idb,{severity:'warn',component:'indexer',eventType:'sol_usd_sample_failed',message:e.message,errorCode:e.code}));
    for(const coin of coins){
     await DB.withLease(idb,'ingest:'+coin.mint,worker,async()=>{
      const r=await ingest({db:idb,rpc},coin,{maxTx:Number(process.env.REWARDS_INGEST_MAX_TX||Infinity)});if(r.newTx||r.holderError)await Logs.log(idb,{component:'indexer',eventType:'history_ingested',mint:coin.mint,message:`History: +${r.newTx} transaction(s), ${r.newEvents} event(s); ${r.fetched}/${r.total} fetched`+(r.holders!=null?`, ${r.holders} holder account(s), ${r.mismatched??0} needed their own history`:r.fallback?`, holder list unavailable (${r.holderError||'fallback'})`:'')+`; coverage ${r.complete?'complete':'in progress'} through slot ${r.head}`,metadata:{incomplete:r.incomplete.slice(0,5)}});
      await heartbeat({db:idb,connection},coin).catch(e=>Logs.log(idb,{severity:'warn',component:'indexer',eventType:'heartbeat_failed',mint:coin.mint,message:e.message,errorCode:e.code||'HEARTBEAT_FAILED'}));
      await backfillSolUsd({db:idb},coin.mint).catch(e=>Logs.log(idb,{severity:'warn',component:'indexer',eventType:'sol_usd_backfill_failed',mint:coin.mint,message:e.message,errorCode:e.code}));
      if(coin.kind!=='primary'&&program)await R.scanIntake({db:idb,rpc,program},coin);   // creator-fee income vs setup rent/donations
      await projectToken({db:idb,connection},coin);
     },{seconds:300,busy:()=>null}).catch(e=>Logs.log(idb,{severity:'error',component:'indexer',eventType:'ingest_failed',mint:coin.mint,message:e.message,errorCode:e.code||'INDEXER_ERROR'}));
    }
    await Logs.heartbeat(idb,'indexer','ok',{coins:coins.length,ms:Date.now()-started});
   }
   if(settles)await Inbox.processInbox(sdb,{worker}).catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'key_inbox_failed',message:e.message,errorCode:e.code||'INBOX_FAILED'}));
   if(settles)await applyBudgetRequests(sdb,{connection,program}).catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'funding_budget_failed',message:e.message,errorCode:e.code||'BUDGET_FAILED'}));
   if(settles)await Admin.applyOpeningRequests(sdb,connection).catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'opening_credit_failed',message:e.message}));
   if(settles)for(const coin of coins.filter(c=>c.kind==='primary'))   // dev-wallet funding ledger (scheduler-only writes)
    await DB.withLease(sdb,'funding:'+coin.mint,worker,async()=>{const r=await reconcileFunding({db:sdb,rpc,program},coin);
     if(r?.gap)await Logs.log(sdb,{severity:'warn',component:'scheduler',eventType:'funding_reconcile_gap',mint:coin.mint,message:'Dev-wallet reconciliation paused at an unreadable or incomplete history ('+r.gap+'); it resumes from there'});
    },{seconds:120,busy:()=>null}).catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'funding_reconcile_failed',mint:coin.mint,message:e.message,errorCode:e.code||'RECONCILE_FAILED'}));
   // Direct settlement (no program): rounds are paid by the fee wallet's imported key; no program keys needed.
   const settlement=settles?Object.fromEntries((await sdb.query('SELECT namespace,settlement FROM reward_platform')).rows.map(r=>[r.namespace,r.settlement])):{};
   if(settles)for(const coin of coins.filter(c=>c.status==='active'&&c.kind==='primary'&&settlement[c.namespace]==='direct'))
    await Direct.tick({db:sdb,connection,worker,inputs,now:async()=>connection.getBlockTime(await connection.getSlot('finalized')),
     cutoffSlot:async t=>(await H.findCutoffSlot(rpc,t)).slot,signer:fw=>Signer.load(sdb,fw.signer)},coin)
     .catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'tick_failed',mint:coin.mint,message:e.message,errorCode:e.code||'SCHEDULER_ERROR'}));
   const programCoins=coins.filter(c=>settlement[c.namespace]!=='direct');
   const signing=settles&&program&&feePayer&&publisher&&verifierKey&&programCoins.length>0;
   if(signing&&Date.now()-checked.at>60000){checked={...await preflightV3({connection,program,publisher:publisher.publicKey,verifier:verifierKey.publicKey}).catch(e=>({ok:false,reason:'preflight failed: '+e.message})),at:Date.now()};
    if(!checked.ok)await Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'preflight_failed',message:'Settlement disabled: '+checked.reason,errorCode:'PREFLIGHT'});}
   if(signing&&!checked.ok)await Logs.heartbeat(sdb,'scheduler','down',{reason:'preflight: '+checked.reason});
   else if(signing){
    const ports={db:sdb,connection,program,feePayer,publisher,verifierKey:verifierKey.publicKey,worker,inputs,
     verifier:{cosign:V.cosigner({db:vdb,program,key:verifierKey,inputs:inputsLoader(vdb)}),...R.attestor({rpc:new H.Rpc(process.env.VERIFIER_RPC_URL||historyUrl,{minIntervalMs:100}),connection,program,key:verifierKey})},
     cutoffSlot:async t=>(await H.findCutoffSlot(rpc,t)).slot,now:async()=>connection.getBlockTime(await connection.getSlot('finalized')),
     devSigner:async coin=>{const fw=(await sdb.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired' AND mode='automatic'",[coin.mint])).rows[0];return fw?.signer?Signer.load(sdb,fw.signer):null;},
     primaryAwaiting:async(mint,cutoff,chainCoin)=>{const v=await budgetAvailable(sdb,connection,mint,chainCoin);return v??primaryAwaiting(sdb,mint,cutoff);},sponsorRent:process.env.REWARDS_SPONSOR_RENT==='true'};
    for(const r of await Admin.syncPrimary(sdb,{connection,program}).catch(e=>(Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'primary_sync_failed',message:e.message}),[])))if(r.state==='active'){const c=coins.find(x=>x.mint===r.mint);if(c)c.status='active';}
    for(const coin of programCoins.filter(c=>c.status==='active')){
     await C.tick(ports,coin.mint).catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'tick_failed',mint:coin.mint,message:e.message,errorCode:e.code||'SCHEDULER_ERROR'}));
     if(coin.kind!=='third_party')continue;
     // Third-party funding: collect creator fees → verified receipts → Credit (split once) → PRIMARY buyback/burn.
     await DB.withLease(sdb,'third-party:'+coin.mint,worker,async()=>{
      await R.crank(ports,coin);await R.creditStep(ports,coin);
      const last=(await sdb.query('SELECT id FROM reward_cycles WHERE mint=$1 AND cutoff_time<=$2 ORDER BY cycle_number DESC LIMIT 1',[coin.mint,await ports.now()])).rows[0];
      await BB.step(ports,coin,last?.id||null);
     },{seconds:120,busy:()=>null}).catch(e=>Logs.log(sdb,{severity:'error',component:'scheduler',eventType:'third_party_step_failed',mint:coin.mint,message:e.message,errorCode:e.code||'SCHEDULER_ERROR'}));
    }
    await Logs.heartbeat(sdb,'scheduler','ok',{coins:coins.length});
   }else if(settles)await Logs.heartbeat(sdb,'scheduler','ok',{coins:coins.length,settlement:programCoins.length?'program keys missing: program settlement disabled':'direct'});
   await Logs.heartbeat(role==='scheduler'?sdb:idb,role==='scheduler'?'worker:scheduler':'worker','ok',{role,worker});
  }catch(e){await Logs.heartbeat(role==='scheduler'?sdb:idb,role==='scheduler'?'worker:scheduler':'worker','degraded',{error:Logs.redactText(e.message)}).catch(()=>{});}
  if(!once&&!stop)await new Promise(r=>setTimeout(r,Math.max(1000,5000-(Date.now()-started))));
 }while(!once&&!stop);
 await Promise.all([idb,sdb,vdb].filter(Boolean).map(p=>p.end()));
}
if(require.main===module)main().catch(e=>{process.stderr.write('worker failed: '+(e.code||'')+' '+Logs.redactText(e.message)+'\n');process.exitCode=1;});
module.exports={preflightV3,envOrFile,backfillSolUsd,chainDeposit,ingest,inputsLoader,loadCredits,sampleSolUsd,heartbeat,reconcileFunding,primaryAwaiting,applyBudgetRequests,budgetAvailable,BUDGET_FEE_RESERVE,projectToken,main};
