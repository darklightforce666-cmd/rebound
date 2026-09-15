const crypto = require('node:crypto');
const MAX = (1n << 64n) - 1n;
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function amount(value) {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) throw Error('Amounts must be integer strings');
  const n = BigInt(value); if (n < 0n || n > MAX) throw Error('Amount outside u64'); return n;
}
function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64LE(amount(value)); return b; }
function key(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw Error('Invalid public address');
  let n = 0n; for (const ch of value) { const i = alphabet.indexOf(ch); if(i<0) throw Error('Invalid public address'); n=n*58n+BigInt(i); }
  const bytes=[]; while(n) { bytes.unshift(Number(n&255n)); n >>= 8n; }
  for(const ch of value) { if(ch !== '1') break; bytes.unshift(0); }
  if(bytes.length!==32) throw Error('Public address must decode to 32 bytes'); return Buffer.from(bytes);
}
function hash(...parts) { return crypto.createHash('sha256').update(Buffer.concat(parts.map(p=>Buffer.isBuffer(p)?p:Buffer.from(p)))).digest(); }
function leaf(program, config, round, wallet, value) {
  return {hash:hash('REBOUND:leaf:v1',key(program),key(config),u64(round),key(wallet),u64(value)),sum:amount(value)};
}
function parent(a,b) {
  const order = Buffer.compare(a.hash,b.hash); if(order>0 || (order===0 && a.sum>b.sum)) [a,b]=[b,a];
  const sum=amount(a.sum+b.sum);
  return {hash:hash('REBOUND:node:v1',a.hash,u64(a.sum),b.hash,u64(b.sum)),sum};
}
function build(program,config,round,allocations) {
  if(!allocations.length || allocations.length>65536) throw Error('Expected 1 to 65536 awards');
  const seen = new Set();
  const rows=allocations.map(a=>{ key(a.wallet); const value=amount(a.amount); if(value===0n||seen.has(a.wallet)) throw Error('Zero award or duplicate wallet'); seen.add(a.wallet); return {wallet:a.wallet,amount:value}; }).sort((a,b)=>Buffer.compare(key(a.wallet),key(b.wallet)));
  const levels=[rows.map(a=>leaf(program,config,round,a.wallet,a.amount))];
  while(levels.at(-1).length>1) { const current=levels.at(-1),next=[]; for(let i=0;i<current.length;i+=2) next.push(current[i+1]?parent(current[i],current[i+1]):current[i]); levels.push(next); }
  const claims=rows.map((a,index)=>{const proof=[];let i=index;for(const level of levels.slice(0,-1)){const other=level[i^1];if(other)proof.push({hash:other.hash.toString('hex'),sum:other.sum.toString()});i=Math.floor(i/2);}return {wallet:a.wallet,amount:a.amount.toString(),proof};});
  const root=levels.at(-1)[0];return {root:root.hash.toString('hex'),total:root.sum.toString(),claims};
}
function verify(program,config,round,claim,root,total) {
  if(claim.proof.length>16) return false;
  let n=leaf(program,config,round,claim.wallet,claim.amount);
  for(const p of claim.proof) { if(!/^[a-f0-9]{64}$/.test(p.hash)) return false; n=parent(n,{hash:Buffer.from(p.hash,'hex'),sum:amount(p.sum)}); }
  return n.hash.toString('hex')===root && n.sum===amount(total);
}
module.exports={amount,u64,key,hash,leaf,parent,build,verify};
