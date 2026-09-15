(function (root) {
'use strict';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function isAddress(value){
 if(typeof value!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;
 let n=0n,bytes=0;for(const c of value)n=n*58n+BigInt(alphabet.indexOf(c));for(;n>0n;n>>=8n)bytes++;
 return bytes+value.match(/^1*/)[0].length===32;
}
function units(raw,decimals,precision=6){
 if(!/^\d+$/.test(String(raw))||!Number.isInteger(decimals)||decimals<0||decimals>255)return 'Unavailable';
 const s=String(raw).padStart(decimals+1,'0'),whole=decimals?s.slice(0,-decimals):s;
 const fraction=decimals?s.slice(-decimals).slice(0,precision).replace(/0+$/,''):'';
 if(BigInt(raw)>0n&&BigInt(whole)===0n&&!fraction)return '<'+(1/10**Math.min(decimals,precision)).toFixed(Math.min(decimals,precision));
 return BigInt(whole).toLocaleString('en-US')+(fraction?'.'+fraction:'');
}
function selectPair(pairs,mint){
 if(!Array.isArray(pairs))throw Error('Market data is unavailable. Please retry.');
 return pairs.filter(p=>p.chainId==='solana'&&p.baseToken?.address===mint&&isAddress(p.pairAddress)).sort((a,b)=>(Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0)||(Number(b.volume?.h24)||0)-(Number(a.volume?.h24)||0))[0]||null;
}
const api={isAddress,units,selectPair};
if(typeof module==='object'&&module.exports)module.exports=api;else root.ReboundData=api;
})(typeof window==='object'?window:globalThis);

