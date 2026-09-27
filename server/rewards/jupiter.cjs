'use strict';
// Jupiter swap (owner decision 2026-09-28): the 15 % of a coin paired with another asset is swapped to SOL here,
// then buys and burns the REBOUND token like every SOL coin. Only the quote and the swap instructions come from
// Jupiter; the worker builds, simulates and signs the transaction itself, and refuses it unless the simulation
// shows the wallet giving at most the chosen amount of the asset and receiving at least the minimum SOL.
const {PublicKey,TransactionInstruction,AddressLookupTableAccount}=require('@solana/web3.js');
const WSOL='So11111111111111111111111111111111111111112';
const base=(env=process.env)=>(env.JUPITER_API_URL||'https://lite-api.jup.ag').replace(/\/+$/,'');
const headers=(env=process.env)=>({'content-type':'application/json',...(env.JUPITER_API_KEY?{'x-api-key':env.JUPITER_API_KEY}:{})});

async function quote({inputMint,amount,slippageBps=100,env=process.env,fetchImpl=fetch}){
 const u=new URL(base(env)+'/swap/v1/quote');
 for(const [k,v] of Object.entries({inputMint,outputMint:WSOL,amount:String(amount),slippageBps:String(slippageBps),restrictIntermediateTokens:'true',swapMode:'ExactIn'}))u.searchParams.set(k,v);
 const r=await fetchImpl(u,{headers:headers(env),signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Object.assign(Error('Jupiter quote HTTP '+r.status),{code:'SWAP_QUOTE_UNAVAILABLE'});
 const q=await r.json();
 if(q.inputMint!==inputMint||q.outputMint!==WSOL||String(q.inAmount)!==String(amount)||!/^\d+$/.test(String(q.outAmount))||!/^\d+$/.test(String(q.otherAmountThreshold)))
  throw Object.assign(Error('Jupiter returned a quote for something else'),{code:'SWAP_QUOTE_INVALID'});
 return q;
}
const ix=i=>new TransactionInstruction({programId:new PublicKey(i.programId),keys:i.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:!!a.isSigner,isWritable:!!a.isWritable})),data:Buffer.from(i.data,'base64')});
/** Instructions and lookup tables for `quoteResponse`, swapped by `user` (SOL arrives unwrapped). */
async function instructions({connection,quoteResponse,user,env=process.env,fetchImpl=fetch}){
 const r=await fetchImpl(base(env)+'/swap/v1/swap-instructions',{method:'POST',headers:headers(env),signal:AbortSignal.timeout(15000),
  body:JSON.stringify({quoteResponse,userPublicKey:String(user),wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true})});
 if(!r.ok)throw Object.assign(Error('Jupiter swap instructions HTTP '+r.status),{code:'SWAP_BUILD_UNAVAILABLE'});
 const j=await r.json();if(j.error)throw Object.assign(Error('Jupiter: '+String(j.error).slice(0,120)),{code:'SWAP_BUILD_UNAVAILABLE'});
 const list=[...(j.computeBudgetInstructions||[]),...(j.otherInstructions||[]),...(j.setupInstructions||[]),j.swapInstruction,...(j.cleanupInstruction?[j.cleanupInstruction]:[])].filter(Boolean).map(ix);
 // Only our own wallet may sign anything in the swap.
 for(const i of list)for(const k of i.keys)if(k.isSigner&&!k.pubkey.equals(new PublicKey(user)))throw Object.assign(Error('The swap asks for another signer'),{code:'SWAP_INVALID'});
 const alts=[];
 for(const a of j.addressLookupTableAddresses||[]){const r2=await connection.getAddressLookupTable(new PublicKey(a));if(!r2.value)throw Object.assign(Error('Lookup table unavailable'),{code:'SWAP_BUILD_UNAVAILABLE'});alts.push(r2.value);}
 return{instructions:list,lookupTables:alts};
}
module.exports={quote,instructions,WSOL,AddressLookupTableAccount};
