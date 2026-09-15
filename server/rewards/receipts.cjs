'use strict';
const bs58=require('bs58'),P=require('./policy.cjs'),W=require('./wire.cjs'),DB=require('./db.cjs'),V=require('./verifier.cjs'),I=require('./indexer.cjs'),Project=require('./project.cjs');
function attribute(projection,events){
 const byId=new Map(events.map(e=>[e.id,e])),pending=[],receipts=[];
 const rows=[...projection.accruals.map(x=>({...x,kind:'accrual'})),...projection.conversions.map(x=>({...x,kind:'conversion'})),...projection.receipts.map(x=>({...x,kind:'receipt'}))].map(x=>({...x,execution:byId.get(x.id)}));
 if(rows.some(r=>!r.execution))throw Error('Receipt attribution lacks execution evidence');
 rows.sort((a,b)=>a.execution.slot-b.execution.slot||a.execution.transactionIndex-b.execution.transactionIndex||a.execution.order-b.execution.order);
 for(const r of rows){
  if(r.kind==='accrual')pending.push({...r,remaining:P.int(r.amount),native:r.asset==='native-SOL',conversions:[]});
  if(r.kind==='conversion'){
   let available=P.int(r.amount);
   for(const a of [...pending]){if(!available||a.native||a.vault!==r.source)continue;const use=a.remaining<available?a.remaining:available;if(!use)continue;a.remaining-=use;available-=use;pending.push({...a,remaining:use,native:true,vault:r.destination,conversions:[r.id]});}
  }
  if(r.kind==='receipt'){
   let available=P.int(r.distributed);const sources=[];
   for(const a of pending){if(!available||!a.native||a.vault!==r.sourceVault)continue;const use=a.remaining<available?a.remaining:available;if(!use)continue;a.remaining-=use;available-=use;sources.push({accrual:a.id,amount:use,conversions:a.conversions});}
   receipts.push({...r,amount:P.int(r.distributed)-available,nonFee:available,sources});
  }
 }return{receipts,pending};
}
async function stageReceipts(db,coin,projection){
 const ledger=attribute(projection,projection.events);
 return DB.transaction(db,async tx=>{
  await tx.query('SELECT mint FROM reward_accounts WHERE mint=$1 FOR UPDATE',[coin.mint]);
  for(const a of projection.accruals){const e=projection.events.find(e=>e.id===a.id);await tx.query('INSERT INTO reward_fee_accruals(id,mint,source_vault,asset,amount,slot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[a.id,coin.mint,a.vault,a.asset,String(a.amount),e.slot]);}
  for(const r of ledger.receipts){
   if((await tx.query('SELECT id FROM reward_receipts WHERE id=$1',[r.id])).rows.length)continue;
   if(!r.amount){await DB.audit(tx,'non_fee_distribution',{receipt:r.id,amount:r.nonFee},{mint:coin.mint});continue;}
   await tx.query("INSERT INTO reward_receipts(id,mint,event,signature,instruction_path,amount,asset,source_slot,state,attestation) VALUES($1,$2,$3,$4,$5,$6,'native-SOL',$7,'verified',$8)",[r.id,coin.mint,r.id,r.signature,r.path,String(r.amount),r.slot,P.stable({sources:r.sources,nonFee:r.nonFee,policy:P.POLICY_HASH})]);
   const grouped=new Map();for(const s of r.sources)grouped.set(s.accrual,(grouped.get(s.accrual)||0n)+s.amount);
   for(const[id,amount]of grouped){await tx.query('UPDATE reward_fee_accruals SET collected=collected+$2 WHERE id=$1',[id,String(amount)]);await tx.query('INSERT INTO reward_receipt_sources(receipt,accrual,amount) VALUES($1,$2,$3)',[r.id,id,String(amount)]);}
   await DB.audit(tx,'receipt_attribution',{receipt:r.id,creatorFees:r.amount,nonFee:r.nonFee,sources:r.sources},{mint:coin.mint});
  }return ledger;
 });
}
async function authorizeReceipt({db,connection,program,verifier,receiptId}){
 const r=(await db.query('SELECT * FROM reward_receipts WHERE id=$1',[receiptId])).rows[0];if(!r||!['verified','submitted'].includes(r.state))throw Error('Receipt unavailable');
 const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[r.mint])).rows[0];
 const sourceIds=[r.event,...r.attestation.sources.flatMap(s=>[s.accrual,...s.conversions])];
 const raw=(await db.query('SELECT * FROM reward_events WHERE id=ANY($1::text[])',[sourceIds])).rows;
 if(sourceIds.some(id=>!raw.some(e=>e.id===id)))throw Error('Receipt source evidence missing');
 const events=[];
 // Independent RPC verifies every attributed market execution and unwrap.
 for(const signature of new Set(raw.map(e=>e.signature))){
  const tx=await connection.getParsedTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx||tx.meta?.err)throw Error('Receipt source not finalized');
  const stored=raw.find(e=>e.signature===signature);if(Number(stored.slot)!==tx.slot)throw Error('Receipt source slot mismatch');
  const parsed=I.parseTransaction(I.plain(tx),{slot:tx.slot,time:tx.blockTime,transactionIndex:Number(stored.transaction_index),coins:[coin]});if(parsed.holds.some(h=>!h.wallet))throw Error('Receipt source provenance incomplete');events.push(...parsed.events);
 }
 const fresh=Project.project(events,coin),actual=fresh.receipts.find(e=>e.id===r.event);
 if(!actual||actual.distributed<BigInt(r.amount))throw Error('Actual collection does not back receipt');
 let total=0n;
 for(const s of r.attestation.sources){const a=fresh.accruals.find(a=>a.id===s.accrual);if(!a||a.amount<BigInt(s.amount))throw Error('Actual trade does not back accrual');for(const id of s.conversions){const c=fresh.conversions.find(c=>c.id===id);if(!c||c.source!==a.vault||c.destination!==actual.sourceVault||c.amount<BigInt(s.amount))throw Error('Wrapped SOL conversion unproven');}if(a.asset==='wrapped-SOL'&&!s.conversions.length)throw Error('Missing unwrap');if(a.asset==='native-SOL'&&a.vault!==actual.sourceVault)throw Error('Mixed creator vault attribution');total+=BigInt(s.amount);}
 if(total!==BigInt(r.amount))throw Error('Receipt source totals differ');
 const sourceRows=(await db.query('SELECT a.*,s.amount AS attributed FROM reward_receipt_sources s JOIN reward_fee_accruals a ON a.id=s.accrual WHERE s.receipt=$1',[r.id])).rows;
 if(P.sum(sourceRows.map(s=>s.attributed))!==total||sourceRows.some(s=>s.mint!==r.mint||BigInt(s.collected)>BigInt(s.amount)))throw Error('Receipt ledger attribution mismatch');
 const through=await connection.getSlot('finalized'),issued=await connection.getSlot('confirmed');if(issued-through>P.POLICY.indexLagSlots)throw Error('Receipt index lag');
 const auth={program,deployment:W.addresses(program,r.mint).deployment.toBase58(),mint:r.mint,signature:Buffer.from(bs58.decode(r.signature)),instructionPath:W.hash(r.instruction_path),amount:r.amount,through,issued,expires:issued+P.POLICY.authorizationSlots};
 const message=W.receiptMessage(auth);return{authorization:{...auth,signature:[...auth.signature],instructionPath:auth.instructionPath.toString('hex')},message:message.toString('base64'),signature:V.sign(verifier,message).toString('base64'),verifier:verifier.publicKey.toBase58(),event:W.receiptEvent(auth).toString('hex'),sourceSlot:r.source_slot};
}
module.exports={attribute,stageReceipts,authorizeReceipt};
