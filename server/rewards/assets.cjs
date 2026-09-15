'use strict';
const W=require('./wire.cjs'),P=require('./policy.cjs'),Pump=require('./pump.cjs'),DB=require('./db.cjs');
const {NATIVE_MINT,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync}=require('@solana/spl-token');
function backing({balance,rent,coin}){
 const liabilities=P.int(coin.unallocated)+P.int(coin.reserved)+P.int(coin.operationsPayable);
 const total=P.int(balance),minimum=P.int(rent);if(total<minimum+liabilities)throw Error('Treasury assets do not cover rent and unpaid liabilities');
 return{liabilities,surplus:total-minimum-liabilities};
}
async function reconcile(db,connection,program,mint){
 const a=W.addresses(program,mint),creators=[a.intake,Pump.SDK.feeSharingConfigPda(W.pk(mint))];
 const atas=creators.map(c=>getAssociatedTokenAddressSync(NATIVE_MINT,Pump.SDK.ammCreatorVaultPda(c),true,TOKEN_PROGRAM_ID));
 const addresses=[a.coin,a.intake,...atas],r=await connection.getMultipleAccountsInfoAndContext(addresses,{commitment:'finalized'}),treasury=r.value[0];
 if(!treasury?.owner.equals(W.pk(program)))throw Error('Treasury asset owner mismatch');
 const rent=await connection.getMinimumBalanceForRentExemption(treasury.data.length),coin=W.decode(treasury.data,'coin'),coverage=backing({balance:treasury.lamports,rent,coin});
 const observations=[{address:a.coin,asset:'native-SOL',balance:P.int(treasury.lamports),rent,liabilities:coverage.liabilities,classification:'program-liabilities-and-non-fee-surplus',evidence:{surplus:coverage.surplus}}];
 if(r.value[1]){const intake=r.value[1];if(!intake.owner.equals(W.pk('11111111111111111111111111111111'))||intake.data.length)throw Error('Intake asset owner mismatch');observations.push({address:a.intake,asset:'native-SOL',balance:P.int(intake.lamports),rent:await connection.getMinimumBalanceForRentExemption(0),liabilities:null,classification:'intake-awaiting-receipt-attribution',evidence:{note:'Includes setup, pending fee receipts and donations. Total balance is not income.'}});}
 for(let index=0;index<atas.length;index++){const info=r.value[index+2];if(!info)continue;if(!info.owner.equals(TOKEN_PROGRAM_ID)||info.data.length<165||!info.data.subarray(0,32).equals(NATIVE_MINT.toBuffer())||!info.data.subarray(32,64).equals(Pump.SDK.ammCreatorVaultPda(creators[index]).toBuffer()))throw Error('Creator WSOL asset mismatch');observations.push({address:atas[index],asset:'wrapped-SOL',balance:info.data.readBigUInt64LE(64),rent:await connection.getMinimumBalanceForRentExemption(info.data.length),liabilities:null,classification:'creator-WSOL-awaiting-traced-conversion',evidence:{nativeBacking:P.int(info.lamports),creator:creators[index].toBase58()}});}
 await DB.transaction(db,async tx=>{
  for(const o of observations)await tx.query('INSERT INTO reward_asset_observations(mint,address,slot,asset,balance,rent,liabilities,classification,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[mint,o.address.toBase58(),r.context.slot,o.asset,String(o.balance),String(o.rent),o.liabilities===null?null:String(o.liabilities),o.classification,P.stable(o.evidence)]);
  await tx.query('UPDATE reward_accounts SET rent=$2,unrelated_deposits=$3 WHERE mint=$1',[mint,String(rent),String(coverage.surplus)]);
 });return{slot:r.context.slot,...coverage};
}
module.exports={backing,reconcile};
