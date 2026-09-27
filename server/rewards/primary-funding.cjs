'use strict';
// Primary-token dedicated dev wallet funding (spec §8.2). Owner decision: every newly received
// distributable lamport in this dedicated wallet is gross funding, whatever its source; it is
// split ONCE: 85 % becomes a holder liability that must be transferred to the reward treasury
// with a holder-only deposit, 15 % is retained on the dev wallet (never split again, never sent
// anywhere by REBOUND). Reconciliation is per finalized transaction, never by comparing two
// balance reads, so an unrelated outflow cannot hide an inflow.
const P3=require('./policy-v3.cjs');
const SYSTEM='11111111111111111111111111111111';
const n=x=>BigInt(x);

function keyList(tx){return tx.transaction.message.accountKeys.map(k=>typeof k==='string'?k:k.pubkey);}
function systemTransfers(tx){
 const all=[...tx.transaction.message.instructions,...(tx.meta.innerInstructions||[]).flatMap(i=>i.instructions)];
 return all.filter(i=>(i.programId===SYSTEM||i.programId?.toString?.()===SYSTEM)&&i.parsed&&['transfer','transferWithSeed'].includes(i.parsed.type)).map(i=>({from:i.parsed.info.source,to:i.parsed.info.destination,lamports:n(i.parsed.info.lamports)}));
}

// Classify one finalized transaction for `wallet`. intents: Map(signature → {kind, amount})
// for transactions REBOUND built (holder-only deposits).
function classify(tx,wallet,intents=new Map()){
 const signature=tx.transaction.signatures[0],slot=Number(tx.slot),time=Number(tx.blockTime);
 if(tx.meta?.err)return{signature,slot,time,failed:true,fee:tx.meta&&keyList(tx)[0]===wallet?n(tx.meta.fee):0n,inflow:0n,outflow:0n};
 const keys=keyList(tx),i=keys.indexOf(wallet);if(i<0)return{signature,slot,time,inflow:0n,outflow:0n,fee:0n,unrelated:true};
 const delta=n(tx.meta.postBalances[i])-n(tx.meta.preBalances[i]),fee=keys[0]===wallet?n(tx.meta.fee):0n;
 const transfers=systemTransfers(tx),tin=transfers.filter(t=>t.to===wallet&&t.from!==wallet).reduce((s,t)=>s+t.lamports,0n),tout=transfers.filter(t=>t.from===wallet&&t.to!==wallet).reduce((s,t)=>s+t.lamports,0n);
 const residual=delta-(tin-tout-fee);  // program-level lamport moves (rent refunds, program payouts)
 const inflow=tin+(residual>0n?residual:0n),outflow=tout+(residual<0n?-residual:0n);
 const intent=intents.get(signature);
 return{signature,slot,time,delta,fee,inflow,outflow,residual,intent:intent||null,postBalance:n(tx.meta.postBalances[i])};
}

// A pair coin's wallet, in its quote asset: the same shape as classify(), measured on the wallet's token
// accounts of `mint` (every account the wallet owns for it). Inflow/outflow come from the SPL transfers into and
// out of those accounts (CPI included); what a program moved without a transfer instruction is the residual.
// Network fees are SOL and are not part of this ledger.
const TOKEN_PROGRAMS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
function tokenTransfers(tx){
 const all=[...(tx.transaction.message.instructions||[]),...(tx.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[])];
 return all.filter(i=>TOKEN_PROGRAMS.has(String(i.programId))&&i.parsed&&['transfer','transferChecked','transferCheckedWithFee'].includes(i.parsed.type))
  .map(i=>({source:i.parsed.info.source,destination:i.parsed.info.destination,amount:n(i.parsed.info.amount??i.parsed.info.tokenAmount?.amount??0)}));
}
function classifyToken(tx,wallet,mint,intents=new Map()){
 const signature=tx.transaction.signatures[0],slot=Number(tx.slot),time=Number(tx.blockTime);
 if(tx.meta?.err)return{signature,slot,time,failed:true,fee:0n,inflow:0n,outflow:0n};
 const keys=keyList(tx),mine=new Set(),pre=new Map(),post=new Map();
 for(const b of tx.meta.preTokenBalances||[])if(b.mint===mint&&b.owner===wallet){const k=keys[b.accountIndex];mine.add(k);pre.set(k,n(b.uiTokenAmount.amount));}
 for(const b of tx.meta.postTokenBalances||[])if(b.mint===mint&&b.owner===wallet){const k=keys[b.accountIndex];mine.add(k);post.set(k,n(b.uiTokenAmount.amount));}
 if(!mine.size)return{signature,slot,time,inflow:0n,outflow:0n,fee:0n,unrelated:true};
 let before=0n,after=0n;for(const k of mine){before+=pre.get(k)||0n;after+=post.get(k)||0n;}
 const t=tokenTransfers(tx),tin=t.filter(x=>mine.has(x.destination)&&!mine.has(x.source)).reduce((a,x)=>a+x.amount,0n),tout=t.filter(x=>mine.has(x.source)&&!mine.has(x.destination)).reduce((a,x)=>a+x.amount,0n);
 const delta=after-before,residual=delta-(tin-tout);
 const inflow=tin+(residual>0n?residual:0n),outflow=tout+(residual<0n?-residual:0n);
 const intent=intents.get(signature);
 return{signature,slot,time,delta,fee:0n,inflow,outflow,residual,intent:intent||null,postBalance:after,asset:mint};
}

// Apply classified transactions (ascending slot order) to the primary funding state.
// state: {credited, holderAwaiting, holderAvailable, holderReserved, holderPaid, retained, carry,
//         operationalReserve, throughSlot}
function reconcile(state,classified,{openingSlot=null}={}){
 const s={...state},credits=[],movements=[],incidents=[];
 for(const c of classified){
  if(c.unrelated)continue;
  if(openingSlot!==null&&c.slot<=openingSlot)continue;
  if(s.throughSlot!=null&&c.slot<=s.throughSlot&&!c.replay)continue;
  if(c.fee>0n)movements.push({id:c.signature+':fee',signature:c.signature,slot:c.slot,time:c.time,direction:'out',lamports:c.fee,classification:'network_fee'});
  if(c.failed){s.throughSlot=c.slot;continue;}
  if(c.intent?.kind==='holder_deposit'){
   // REBOUND-built holder-only deposit: moves liability to the treasury; never new funding.
   const expected=n(c.intent.amount);
   if(c.outflow!==expected||c.inflow!==0n){incidents.push({signature:c.signature,reason:'holder_deposit_amount_mismatch',expected,outflow:c.outflow});}
   const moved=c.outflow<expected?c.outflow:expected;
   if(moved>s.holderAwaiting){incidents.push({signature:c.signature,reason:'holder_deposit_exceeds_liability'});}
   s.holderAwaiting-=moved>s.holderAwaiting?s.holderAwaiting:moved;s.holderAvailable+=moved;
   movements.push({id:c.signature+':holder',signature:c.signature,slot:c.slot,time:c.time,direction:'out',lamports:moved,classification:'holder_transfer'});
  }else{
   if(c.inflow>0n){
    const sp=P3.splitFunding(c.inflow,s.carry);
    credits.push({id:c.signature+':in',signature:c.signature,instructionPath:'tx',slot:c.slot,time:c.time,gross:c.inflow,holder:sp.holder,other:sp.other,carryBefore:s.carry,carryAfter:sp.carry,residual:c.residual});
    s.credited+=c.inflow;s.holderAwaiting+=sp.holder;s.retained+=sp.other;s.carry=sp.carry;
    movements.push({id:c.signature+':in',signature:c.signature,slot:c.slot,time:c.time,direction:'in',lamports:c.inflow,classification:'funding'});
   }
   if(c.outflow>0n)movements.push({id:c.signature+':out',signature:c.signature,slot:c.slot,time:c.time,direction:'out',lamports:c.outflow,classification:'owner_withdrawal'});
  }
  // Backing: holder liabilities still on the wallet plus the operating reserve must remain.
  if(c.postBalance!=null){
   const need=s.holderAwaiting+s.operationalReserve;
   if(c.postBalance<need)incidents.push({signature:c.signature,slot:c.slot,reason:'insufficient_backing',shortfall:need-c.postBalance,balance:c.postBalance,liabilities:s.holderAwaiting,reserve:s.operationalReserve});
  }
  s.throughSlot=c.slot;
 }
 return{state:s,credits,movements,incidents};
}
// Funding attributable to a cycle: credits finalized at or before the cutoff and not yet planned.
function fundingThrough(credits,cutoff){return credits.filter(c=>c.time<=Number(cutoff));}

// Opening enrollment: record one explicit opening credit for the owner-chosen spendable amount.
function opening({balance,requestedCredit,operationalReserve}){
 const b=n(balance),r=n(operationalReserve),want=n(requestedCredit);
 if(want+r>b)throw Object.assign(Error('Opening credit plus reserve exceeds the wallet balance'),{code:'INSUFFICIENT_BACKING'});
 return want;
}
module.exports={classify,classifyToken,reconcile,fundingThrough,opening,systemTransfers,tokenTransfers};
