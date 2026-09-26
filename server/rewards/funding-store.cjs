'use strict';
// Persist primary dev-wallet reconciliation (spec §8.2, §8.4). Idempotent per finalized
// transaction; applied in one serializable DB transaction together with the bucket update, the
// immutable credit/movement rows and a ledger entry. The CHECK constraint on
// reward_funding_accounts enforces: credited = awaiting + available + reserved + paid + other.
const DB=require('./db.cjs'),F=require('./primary-funding.cjs'),{stable}=require('./policy.cjs'),W=require('./wire.cjs');
const b=x=>BigInt(x);
function toState(row,reserve=0n){return{credited:b(row.credited),holderAwaiting:b(row.holder_awaiting_transfer),holderAvailable:b(row.holder_available),holderReserved:b(row.holder_reserved),holderPaid:b(row.holder_paid),retained:b(row.other_settled),carry:b(row.split_carry),operationalReserve:b(reserve),throughSlot:row.chain_slot==null?null:Number(row.chain_slot)};}

async function ensureAccount(db,mint){await db.query("INSERT INTO reward_funding_accounts(mint,kind) VALUES($1,'primary') ON CONFLICT DO NOTHING",[mint]);}

// Record the one-time opening credit chosen by the admin (never repeated).
async function recordOpening(db,{mint,wallet,balance,requestedCredit,operationalReserve,slot,time}){
 const credit=F.opening({balance,requestedCredit,operationalReserve});
 return DB.transaction(db,async tx=>{
  await ensureAccount(tx,mint);
  const fw=(await tx.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired' FOR UPDATE",[mint])).rows[0];
  if(!fw||fw.address!==wallet)throw Object.assign(Error('Funding wallet is not connected for this mint'),{code:'FORBIDDEN'});
  if(fw.opening_slot!=null)throw Object.assign(Error('Opening credit was already recorded'),{code:'ALREADY_RECORDED'});
  await tx.query('UPDATE reward_funding_wallets SET opening_balance_lamports=$2,opening_credit_lamports=$3,opening_slot=$4,operational_reserve_lamports=$5,reconciled_through_slot=$4 WHERE id=$1',[fw.id,String(balance),String(credit),slot,String(operationalReserve)]);
  if(credit>0n)await applyCredits(tx,mint,[{id:'opening:'+wallet+':'+slot,signature:null,instructionPath:'opening',slot,time,gross:credit,source:'primary_opening'}]);
  await tx.query('UPDATE reward_funding_accounts SET chain_slot=$2,operational_reserve=$3 WHERE mint=$1',[mint,slot,String(operationalReserve)]);
  return{credit};
 });
}

async function applyCredits(tx,mint,credits){
 for(const c of credits){
  const row=(await tx.query('SELECT * FROM reward_funding_accounts WHERE mint=$1 FOR UPDATE',[mint])).rows[0];
  const exists=(await tx.query('SELECT 1 FROM reward_funding_credits WHERE id=$1',[c.id])).rows.length;if(exists)continue;
  const s=require('./policy-v3.cjs').splitFunding(c.gross,row.split_carry);
  await tx.query('INSERT INTO reward_funding_credits(id,mint,source,gross_lamports,holder_lamports,other_lamports,carry_before,carry_after,signature,instruction_path,slot,block_time,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
   [c.id,mint,c.source||'primary_wallet',String(c.gross),String(s.holder),String(s.other),row.split_carry,Number(s.carry),c.signature,c.instructionPath||'tx',c.slot,c.time,stable({residual:c.residual??null})]);
  const before={credited:row.credited,holder_awaiting_transfer:row.holder_awaiting_transfer,other_settled:row.other_settled,split_carry:row.split_carry};
  await tx.query('UPDATE reward_funding_accounts SET credited=credited+$2,holder_awaiting_transfer=holder_awaiting_transfer+$3,other_settled=other_settled+$4,split_carry=$5,version=version+1,updated_at=now() WHERE mint=$1',[mint,String(c.gross),String(s.holder),String(s.other),Number(s.carry)]);
  const after=(await tx.query('SELECT credited,holder_awaiting_transfer,other_settled,split_carry FROM reward_funding_accounts WHERE mint=$1',[mint])).rows[0];
  await tx.query('INSERT INTO reward_ledger(id,mint,kind,reference,deltas,before_state,after_state,chain_signature,chain_slot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
   [W.hash(mint,'funding_credit',c.id).toString('hex'),mint,'funding_credit',c.id,stable({gross:c.gross,holder:s.holder,retained:s.other}),stable(before),stable(after),c.signature,c.slot]);
 }
}

// Apply classified wallet transactions (ascending order) exactly once.
async function applyWalletTransactions(db,{mint,wallet,classified}){
 return DB.transaction(db,async tx=>{
  await ensureAccount(tx,mint);
  const row=(await tx.query('SELECT * FROM reward_funding_accounts WHERE mint=$1 FOR UPDATE',[mint])).rows[0];
  const fw=(await tx.query("SELECT * FROM reward_funding_wallets WHERE mint=$1 AND status<>'retired' FOR UPDATE",[mint])).rows[0];
  if(!fw||fw.address!==wallet)throw Object.assign(Error('Funding wallet is not connected for this mint'),{code:'FORBIDDEN'});
  const r=F.reconcile(toState(row,fw.operational_reserve_lamports),classified,{openingSlot:fw.opening_slot==null?null:Number(fw.opening_slot)});
  await applyCredits(tx,mint,r.credits.map(c=>({...c,source:'primary_wallet'})));
  for(const m of r.movements)await tx.query('INSERT INTO reward_wallet_movements(id,mint,address,direction,lamports,classification,signature,slot,block_time,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING',[m.id,mint,wallet,m.direction,String(m.lamports),m.classification,m.signature,m.slot,m.time,'{}']);
  const deposits=r.movements.filter(m=>m.classification==='holder_transfer').reduce((s,m)=>s+m.lamports,0n);
  if(deposits>0n)await tx.query('UPDATE reward_funding_accounts SET holder_awaiting_transfer=holder_awaiting_transfer-$2,holder_available=holder_available+$2,version=version+1 WHERE mint=$1',[mint,String(deposits)]);
  if(r.state.throughSlot!=null)await tx.query('UPDATE reward_funding_accounts SET chain_slot=$2,updated_at=now() WHERE mint=$1',[mint,r.state.throughSlot]);
  if(r.state.throughSlot!=null)await tx.query('UPDATE reward_funding_wallets SET reconciled_through_slot=$2 WHERE id=$1',[fw.id,r.state.throughSlot]);
  for(const i of r.incidents){
   await tx.query('INSERT INTO reward_logs(severity,component,event_type,mint,safe_message,error_code,transaction_signature,safe_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    ['critical','funding','funding_incident',mint,i.reason==='insufficient_backing'?`Dev wallet backing below holder liabilities by ${i.shortfall} lamports; new funding paused`:'Funding incident: '+i.reason,i.reason==='insufficient_backing'?'INSUFFICIENT_BACKING':i.reason.toUpperCase(),i.signature||null,stable(i)]);
   if(i.reason==='insufficient_backing')await tx.query("UPDATE reward_coins SET status='paused',blocked_reason='insufficient_backing',updated_at=now() WHERE mint=$1 AND status NOT IN ('retired')",[mint]);
  }
  return r;
 });
}
module.exports={toState,recordOpening,applyWalletTransactions,applyCredits};
