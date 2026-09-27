'use strict';
// The asset a coin is priced, measured and paid in: SOL, or the SPL mint it was paired with on pump.fun
// (coin.quote_mint). For a pair coin every *_lamports amount of that coin (costs, losses, awards, payouts,
// its income ledger) is in base units of that asset.
const {PublicKey}=require('@solana/web3.js');
const {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction}=require('@solana/spl-token');
const I=require('./indexer.cjs');

/** {mint, program, decimals, symbol} of a pair coin's quote asset; null for SOL coins. Filled from the chain when
 *  the coin row does not carry it yet (older rows). */
async function info(connection,coin){
 const mint=I.quoteOf(coin);if(!mint)return null;
 if(coin.quote_token_program&&coin.quote_decimals!=null)return{mint,program:coin.quote_token_program,decimals:Number(coin.quote_decimals),symbol:coin.quote_symbol||null};
 const a=await connection.getParsedAccountInfo(new PublicKey(mint),'confirmed');const p=a.value?.data?.parsed;
 if(!a.value||p?.type!=='mint')throw Object.assign(Error('Pair asset mint unreadable'),{code:'QUOTE_MINT_UNREADABLE'});
 return{mint,program:a.value.owner.toBase58(),decimals:Number(p.info.decimals),symbol:coin.quote_symbol||null};
}
const ata=(owner,q)=>getAssociatedTokenAddressSync(new PublicKey(q.mint),new PublicKey(owner),true,new PublicKey(q.program));
/** Balance of `owner`'s associated account of the asset (0 when it does not exist). */
async function balance(connection,owner,q){
 try{const r=await connection.getTokenAccountBalance(ata(owner,q),'confirmed');return BigInt(r.value.amount);}
 catch(e){if(/could not find account|Invalid param|not found/i.test(String(e.message)))return 0n;throw e;}
}
/** Transfer of `amount` base units from `from` (signer) to `to`'s associated account; `create` first makes that
 *  account (idempotent; rent paid by `payer`). */
function transfer({from,to,amount,q,payer=from,create=false}){
 const mint=new PublicKey(q.mint),program=new PublicKey(q.program),dest=ata(to,q),out=[];
 if(create)out.push(createAssociatedTokenAccountIdempotentInstruction(new PublicKey(payer),dest,new PublicKey(to),mint,program));
 out.push(createTransferCheckedInstruction(ata(from,q),mint,dest,new PublicKey(from),BigInt(amount),q.decimals,[],program));
 return out;
}
module.exports={info,ata,balance,transfer};
