'use strict';
// Token metadata for display (name, symbol, image). Token-2022 mints carry it in the tokenMetadata extension;
// classic SPL mints in the Metaplex metadata account. The image comes from the metadata JSON at `uri`.
// Display only — never used for rewards.
const {PublicKey}=require('@solana/web3.js');
const METAPLEX=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const clean=s=>String(s||'').replace(/\0/g,'').trim();
function metaplexDecode(data){
 // key u8, update authority 32, mint 32, then borsh strings name/symbol/uri (u32 length + bytes).
 let o=1+32+32;const str=()=>{const n=data.readUInt32LE(o);o+=4;const s=data.subarray(o,o+n).toString('utf8');o+=n;return clean(s);};
 return{name:str(),symbol:str(),uri:str()};
}
async function onchain(connection,mint){
 const key=new PublicKey(mint);
 const info=await connection.getParsedAccountInfo(key,'confirmed');const p=info.value?.data?.parsed;
 if(!p||p.type!=='mint')return null;
 const md=(p.info.extensions||[]).find(e=>e.extension==='tokenMetadata')?.state;
 if(md)return{name:clean(md.name),symbol:clean(md.symbol),uri:clean(md.uri)};
 const pda=PublicKey.findProgramAddressSync([Buffer.from('metadata'),METAPLEX.toBuffer(),key.toBuffer()],METAPLEX)[0];
 const acc=await connection.getAccountInfo(pda,'confirmed');
 return acc?metaplexDecode(acc.data):null;
}
// Only https metadata/image URLs are used (ipfs:// is mapped to a public gateway).
const httpUrl=u=>{u=clean(u);if(u.startsWith('ipfs://'))u='https://ipfs.io/ipfs/'+u.slice(7);return /^https:\/\/[^\s"'<>]{4,500}$/.test(u)?u:null;};
async function resolve(connection,mint,{fetchImpl=fetch,timeoutMs=6000}={}){
 const m=await onchain(connection,mint);if(!m)return null;
 let image=null;const uri=httpUrl(m.uri);
 if(uri)try{const r=await fetchImpl(uri,{signal:AbortSignal.timeout(timeoutMs)});if(r.ok){const j=await r.json();image=httpUrl(j?.image);}}catch{}
 return{name:m.name.slice(0,64)||null,symbol:m.symbol.slice(0,16)||null,uri,image};
}
module.exports={resolve,onchain,metaplexDecode,httpUrl};
