'use strict';
// Builds V3 instructions with server/rewards/wire-v3.cjs for the Python parity test.
// stdin: {op, args}; stdout: {data64, keys:[{pubkey,isSigner,isWritable}], extra}
const W=require('../../../server/rewards/wire-v3.cjs');
let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{
 const {op,program,args}=JSON.parse(input);let out={};
 const enc=i=>({data64:Buffer.from(i.data).toString('base64'),keys:i.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable}))});
 if(op==='tree'){const t=W.tree(args.context,args.awards.map((a,index)=>({index,wallet:a.wallet,amount:a.amount})));out={root:{hash:t.root.hash.toString('hex'),sum:String(t.root.sum)},proofs:t.awards.map(a=>a.proof.map(n=>({hash:n.hash.toString('hex'),sum:String(n.sum)})))};}
 else if(op==='decode'){out=JSON.parse(JSON.stringify(W.decode(args.kind,Buffer.from(args.data64,'base64')),(k,v)=>typeof v==='bigint'?v.toString():v));}
 else out=enc(W.I[op](program,args));
 process.stdout.write(JSON.stringify(out));
});
