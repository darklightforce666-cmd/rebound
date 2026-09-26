'use strict';
// Mint inspection (spec §7.1, §11.1): owner program, decimals, supply, authorities and
// Token-2022 extensions. Extensions that change transfer amounts, move tokens without the owner
// or hide balances make lot accounting unprovable, so they fail explicitly.
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN_2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SAFE=new Set(['metadataPointer','tokenMetadata','groupPointer','groupMemberPointer','tokenGroup','tokenGroupMember','mintCloseAuthority','immutableOwner']);
function inspect(info){
 if(!info)return{ok:false,reason:'MINT_INVALID',detail:'account not found'};
 const owner=typeof info.owner==='string'?info.owner:info.owner?.toBase58?.();
 if(owner!==TOKEN&&owner!==TOKEN_2022)return{ok:false,reason:'MINT_INVALID',detail:'not owned by a token program'};
 const p=info.data?.parsed;if(p?.type!=='mint')return{ok:false,reason:'MINT_INVALID',detail:'not a mint account'};
 const m=p.info,blockers=[];
 for(const e of m.extensions||[]){
  const name=e.extension;if(SAFE.has(name))continue;
  if(name==='transferFeeConfig'){const s=e.state||{};const fees=[s.olderTransferFee?.transferFeeBasisPoints,s.newerTransferFee?.transferFeeBasisPoints].map(Number);if(fees.some(f=>f>0)||s.transferFeeConfigAuthority)blockers.push('transfer_fee');continue;}
  if(name==='transferHook'){if(e.state?.programId)blockers.push('transfer_hook');continue;}
  if(name==='defaultAccountState'){if(e.state?.accountState!=='initialized')blockers.push('default_account_frozen');continue;}
  blockers.push('unsupported_extension:'+name);
 }
 const res={ok:blockers.length===0,reason:blockers.length?'MINT_UNSUPPORTED':null,blockers,tokenProgram:owner,decimals:m.decimals,supply:String(m.supply),mintAuthority:m.mintAuthority||null,freezeAuthority:m.freezeAuthority||null,extensions:(m.extensions||[]).map(e=>e.extension)};
 if(!Number.isInteger(res.decimals)||res.decimals<0||res.decimals>18)return{...res,ok:false,reason:'MINT_INVALID',blockers:[...blockers,'decimals']};
 return res;
}
async function fetchMint(rpc,mint){const r=await rpc.call('getAccountInfo',[mint,{encoding:'jsonParsed',commitment:'finalized'}]);return inspect(r?.value);}
module.exports={TOKEN,TOKEN_2022,inspect,fetchMint};
