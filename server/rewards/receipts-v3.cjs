'use strict';
// Third-party creator-fee funding (spec §8.3): collect → observe → attest → Credit (split once on chain).
// * Creator fees accrue in Pump's creator vaults of the coin's intake (before fee sharing) and of its
//   fee-sharing config (after sharing, and after graduation once PumpSwap fees are swept back).
//   Collection is permissionless; REBOUND cranks it, but anybody may — every finalized transaction
//   that moves lamports from those vaults into the intake is income, whoever sent it.
// * Only those transfers are credited. Setup rent, donations and any other inflow to the intake are
//   recorded as wallet movements and never split (spec: not automatically creator-fee income).
// * One receipt per collection transaction; its event hash is the on-chain receipt PDA seed, so a
//   transaction can never be credited twice, and the verifier re-measures it independently.
const bs58=require('bs58');
const {ComputeBudgetProgram,PublicKey}=require('@solana/web3.js');
const {NATIVE_MINT,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync}=require('@solana/spl-token');
const DB=require('./db.cjs'),W3=require('./wire-v3.cjs'),PV=require('./pump-v3.cjs'),P3=require('./policy-v3.cjs'),H=require('./history-v3.cjs');
const T=require('./transport-v3.cjs'),Logs=require('./logs.cjs'),{stable}=require('./policy.cjs'),{systemTransfers}=require('./primary-funding.cjs');
const b=x=>BigInt(x);
const PATH='collection';   // one receipt per collection transaction

function vaults(program,mint){
 const a=W3.addresses(program,mint),sharing=PV.SDK.feeSharingConfigPda(W3.pk(mint));
 return{intake:a.intake.toBase58(),sharingConfig:sharing.toBase58(),sources:[PV.SDK.creatorVaultPda(a.intake).toBase58(),PV.SDK.creatorVaultPda(sharing).toBase58()]};
}
/** Creator-fee lamports that one finalized transaction moved into the intake (and everything else). */
function measure(tx,{intake,sources}){
 if(!tx||tx.meta?.err)return{amount:0n,income:[],other:[]};
 const moves=systemTransfers(tx).filter(t=>t.to===intake&&t.from!==intake);
 const income=moves.filter(t=>sources.includes(t.from)),other=moves.filter(t=>!sources.includes(t.from));
 return{amount:income.reduce((s,t)=>s+t.lamports,0n),income,other};
}
// Settlement for a permissionless crank: the exact signature finalized without error.
const finalizedSuccess=connection=>async sig=>{if(!sig)return{definitivelyUnsettled:true};const st=(await connection.getSignatureStatuses([sig],{searchTransactionHistory:true})).value[0];
 return st&&st.confirmationStatus==='finalized'&&!st.err?{settled:true,signature:sig,slot:st.slot}:{definitivelyUnsettled:!st};};
const eventOf=(mint,signature)=>W3.receiptEvent({signature:bs58.decode(signature),instructionPath:W3.hash(PATH),mint});

/** Indexer: finalized history of the intake → receipts (income) and wallet movements (non-income). */
async function scanIntake({db,rpc,program},coin){
 const v=vaults(program,coin.mint);
 await db.query("INSERT INTO reward_history_cursors(mint,address,role) VALUES($1,$2,'intake') ON CONFLICT DO NOTHING",[coin.mint,v.intake]);
 const cur=(await db.query("SELECT * FROM reward_history_cursors WHERE mint=$1 AND address=$2",[coin.mint,v.intake])).rows[0];
 const r=await H.signaturesFor(rpc,v.intake,{until:cur.newest_signature||null});let gap=!r.complete,found=0;
 for(const s of r.signatures.filter(x=>!x.err).reverse()){
  const tx=await rpc.call('getTransaction',[s.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:H.TX_VERSION}]);
  if(!tx){gap=true;break;}
  const m=measure(tx,v);
  await DB.transaction(db,async t=>{
   if(m.amount>0n){const ins=await t.query("INSERT INTO reward_intake_receipts(id,mint,signature,instruction_path,amount_lamports,sources,slot,block_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",
    [eventOf(coin.mint,s.signature).toString('hex'),coin.mint,s.signature,PATH,String(m.amount),stable(m.income.map(x=>({from:x.from,lamports:x.lamports}))),tx.slot,tx.blockTime]);found+=ins.rows.length;}
   for(const [i,o] of m.other.entries())await t.query("INSERT INTO reward_wallet_movements(id,mint,address,direction,lamports,classification,signature,slot,block_time,evidence) VALUES($1,$2,$3,'in',$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
    [`${s.signature}:intake:${i}`,coin.mint,v.intake,String(o.lamports),o.from===coin.creator_wallet?'rent':'donation',s.signature,tx.slot,tx.blockTime,stable({from:o.from,note:'not creator-fee income; never credited'})]);
  });
 }
 if(r.signatures.length&&!gap)await db.query('UPDATE reward_history_cursors SET newest_signature=$3,newest_slot=$4,updated_at=now() WHERE mint=$1 AND address=$2',[coin.mint,v.intake,r.signatures[0].signature,r.signatures[0].slot]);
 return{receipts:found,complete:!gap};
}

/** Collection instructions for whatever creator fees are currently pending (none → []). */
async function pendingCollection(connection,program,mint,payer){
 mint=W3.pk(mint);const v=vaults(program,mint),rent=BigInt(await connection.getMinimumBalanceForRentExemption(0));
 const [vi,vs,bc,sc]=await connection.getMultipleAccountsInfo([new PublicKey(v.sources[0]),new PublicKey(v.sources[1]),PV.SDK.bondingCurvePda(mint),new PublicKey(v.sharingConfig)]);
 const ixs=[];
 if(vi&&BigInt(vi.lamports)>rent)ixs.push(await PV.collectInitial(program,mint));
 if(!sc)return ixs;
 const graduated=bc?PV.sdk.decodeBondingCurve(bc).complete:false;
 let amm=0n;if(graduated){const ata=getAssociatedTokenAddressSync(NATIVE_MINT,PV.AMM.coinCreatorVaultAuthorityPda(new PublicKey(v.sharingConfig)),true,TOKEN_PROGRAM_ID);const a=await connection.getAccountInfo(ata);if(a)amm=Buffer.from(a.data).readBigUInt64LE(64);}
 if((vs&&BigInt(vs.lamports)>rent)||amm>0n)ixs.push(...await PV.collect({program,mint,payer,sharingConfig:PV.sdk.decodeSharingConfig(sc),graduated:amm>0n}));
 return ixs;
}
/** Scheduler: crank pending collections (permissionless; fee payer = operations key). */
async function crank(ports,coin){
 const {db,connection,program,feePayer}=ports;const ixs=await pendingCollection(connection,program,coin.mint,feePayer.publicKey);if(!ixs.length)return{state:'nothing_pending'};
 const slot=await connection.getSlot('confirmed');const job=`collect:${coin.mint}:${Math.floor(slot/150)}`;
 return T.submit({db,connection,job,kind:'collection',signerRole:'fee_payer',feePayer,signers:[],instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),...ixs],
  readSettlement:finalizedSuccess(connection),spend:{namespace:coin.namespace,mint:coin.mint,recipients:[],lamports:'0',fees:'5000',kind:'collection'},context:{mint:coin.mint}});
}

/** Scheduler: attest (independent verifier) + Credit every observed receipt; mirror the on-chain split. */
async function creditStep(ports,coin){
 const {db,connection,program,feePayer}=ports;const out=[];
 const rows=(await db.query("SELECT * FROM reward_intake_receipts WHERE mint=$1 AND state IN ('observed','credit_submitted') ORDER BY slot,signature",[coin.mint])).rows;
 for(const row of rows){
  const a=W3.addresses(program,coin.mint,{event:Buffer.from(row.id,'hex')});
  const settled=async()=>{const info=await connection.getAccountInfo(a.receipt,'finalized');return info&&info.owner.equals(W3.pk(program))?{settled:true,account:info}:{definitivelyUnsettled:true};};
  const onChain=await settled();
  if(!onChain.settled){
   let att;try{att=await ports.verifier.attestReceipt({mint:coin.mint,signature:row.signature,amount:b(row.amount_lamports)});}
   catch(e){await db.query("UPDATE reward_intake_receipts SET state='held',reason=$2 WHERE id=$1",[row.id,e.code||e.message]);await Logs.log(db,{severity:'warn',component:'scheduler',eventType:'receipt_held',mint:coin.mint,message:`Receipt ${row.signature.slice(0,12)}… held: ${e.message}`,errorCode:e.code||'VERIFIER_REJECTED'});out.push({id:row.id,state:'held'});continue;}
   const r=await T.submit({db,connection,job:'credit:'+row.id,kind:'third_party_credit',signerRole:'fee_payer',feePayer,signers:[],
    instructions:W3.credit(program,{payer:feePayer.publicKey,mint:coin.mint,message:att.message,verifierSignature:att.signature,verifier:att.verifier,event:Buffer.from(row.id,'hex')}),
    readSettlement:settled,spend:{namespace:coin.namespace,mint:coin.mint,recipients:[],lamports:'0',fees:'5000',kind:'third_party_credit'},context:{receipt:row.id}});
   if(r.state!=='finalized'){if(row.state==='observed'&&['submitted','uncertain'].includes(r.state))await db.query("UPDATE reward_intake_receipts SET state='credit_submitted',credit_signature=$2 WHERE id=$1",[row.id,r.signature||null]);out.push({id:row.id,state:r.state,code:r.code});continue;}
  }
  const info=(await settled()).account;const d=Buffer.from(info.data);   // Receipt: magic,coin,event,amount,holders,buyback,source_slot
  const amount=d.readBigUInt64LE(72),holders=d.readBigUInt64LE(80),buyback=d.readBigUInt64LE(88);
  if(amount!==b(row.amount_lamports))throw Object.assign(Error('On-chain receipt amount differs from the observed collection'),{code:'RECEIPT_MISMATCH'});
  await DB.transaction(db,async t=>{
   await t.query("INSERT INTO reward_funding_accounts(mint,kind) VALUES($1,'third_party') ON CONFLICT DO NOTHING",[coin.mint]);
   const acct=(await t.query('SELECT * FROM reward_funding_accounts WHERE mint=$1 FOR UPDATE',[coin.mint])).rows[0];
   const split=P3.splitFunding(amount,acct.split_carry);
   if(split.holder!==holders||split.other!==buyback)throw Object.assign(Error('On-chain split differs from policy'),{code:'SPLIT_MISMATCH'});
   await t.query("INSERT INTO reward_funding_credits(id,mint,source,gross_lamports,holder_lamports,other_lamports,carry_before,carry_after,signature,instruction_path,slot,block_time,evidence) VALUES($1,$2,'creator_fee',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING",
    [row.id,coin.mint,String(amount),String(holders),String(buyback),acct.split_carry,Number(split.carry),row.signature,PATH,row.slot,row.block_time,stable({receipt:a.receipt.toBase58(),sources:row.sources})]);
   await t.query('UPDATE reward_funding_accounts SET credited=credited+$2,holder_available=holder_available+$3,other_available=other_available+$4,split_carry=$5,version=version+1,updated_at=now() WHERE mint=$1',[coin.mint,String(amount),String(holders),String(buyback),Number(split.carry)]);
   await t.query('INSERT INTO reward_ledger(id,mint,kind,reference,deltas,before_state,after_state,chain_signature,chain_slot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',
    [W3.hash(coin.mint,'creator_fee_credit',row.id).toString('hex'),coin.mint,'creator_fee_credit',row.id,stable({gross:amount,holder:holders,buyback}),stable({credited:acct.credited,carry:acct.split_carry}),stable({carry:Number(split.carry)}),row.signature,row.slot]);
   await t.query("UPDATE reward_intake_receipts SET state='credited',holder_lamports=$2,buyback_lamports=$3,receipt_account=$4 WHERE id=$1",[row.id,String(holders),String(buyback),a.receipt.toBase58()]);
  });
  await Logs.log(db,{component:'scheduler',eventType:'creator_fee_credited',mint:coin.mint,message:`Creator fees credited once: ${amount} lamports → ${holders} holders / ${buyback} PRIMARY buyback`,metadata:{signature:row.signature}});
  out.push({id:row.id,state:'credited',amount:String(amount)});
 }
 return out;
}

/**
 * Verifier side (separate key, own RPC): re-fetch the finalized collection, re-measure the income,
 * refuse anything that differs, and sign the exact receipt message the program checks.
 */
function attestor({rpc,connection,program,key}){
 return{async attestReceipt({mint,signature,amount}){
  const tx=await rpc.call('getTransaction',[signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:H.TX_VERSION}]);
  if(!tx)throw Object.assign(Error('Collection transaction is not finalized'),{code:'RECEIPT_NOT_FINALIZED'});
  const m=measure(tx,vaults(program,mint));if(m.amount!==BigInt(amount)||m.amount<=0n)throw Object.assign(Error('Independent measurement differs from the observed receipt'),{code:'VERIFIER_REJECTED'});
  const through=await connection.getSlot('finalized'),issued=Math.max(through,await connection.getSlot('confirmed'));
  if(through<tx.slot)throw Object.assign(Error('Coverage behind the collection'),{code:'RECEIPT_NOT_FINALIZED'});
  const message=W3.receiptMessage(program,W3.addresses(program).deployment,{mint,signature:bs58.decode(signature),instructionPath:W3.hash(PATH),amount:m.amount,through,issued,expires:issued+15});
  const crypto=require('node:crypto');const pkcs8=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(key.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});
  return{message,signature:crypto.sign(null,message,pkcs8),verifier:key.publicKey};
 }};
}

module.exports={finalizedSuccess,PATH,vaults,measure,eventOf,scanIntake,pendingCollection,crank,creditStep,attestor};
