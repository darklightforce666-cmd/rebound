const test=require('node:test'),assert=require('node:assert/strict'),M=require('../client/merkle.cjs'),{buildRound}=require('../client/build-round.cjs');
const P='11111111111111111111111111111111',C='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',W='So11111111111111111111111111111111111111112';
test('all proofs verify for an odd-sized tree, preserving every award',()=>{
 const tree=M.build(P,C,'1',[{wallet:W,amount:'100'},{wallet:C,amount:'200'},{wallet:P,amount:'300'}]);assert.equal(tree.total,'600');for(const c of tree.claims)assert.ok(M.verify(P,C,'1',c,tree.root,tree.total));
});
test('proofs bind wallet, amount, round, config, program, and subtree sums',()=>{
 const t=M.build(P,C,'1',[{wallet:W,amount:'100'},{wallet:C,amount:'200'}]),a=t.claims.find(c=>c.wallet===W);
 for(const [p,c,r,claim,total] of [[C,C,'1',a,t.total],[P,P,'1',a,t.total],[P,C,'2',a,t.total],[P,C,'1',{...a,amount:'101'},t.total],[P,C,'1',{...a,wallet:P},t.total],[P,C,'1',a,'301'],[P,C,'1',{...a,proof:a.proof.map(p=>({...p,sum:'201'}))},t.total]])assert.equal(M.verify(p,c,r,claim,t.root,total),false);
});
test('duplicate wallets, zero awards, overflow, and imprecise numbers fail',()=>{
 assert.throws(()=>M.build(P,C,'1',[{wallet:W,amount:'1'},{wallet:W,amount:'2'}]));assert.throws(()=>M.build(P,C,'1',[{wallet:W,amount:'0'}]));
 assert.throws(()=>M.build(P,C,'1',[{wallet:W,amount:(2n**64n-1n).toString()},{wallet:C,amount:'1'}]));for(const x of [1,1.1,'01','-1','1e4'])assert.throws(()=>M.amount(x));
});
test('round builder follows mature recorded losses and excludes outgoing positions',()=>{
 const at=1800000000,ms=at*1000;
 const position=(wallet,cost,age,outgoing=false)=>({wallet,hasOutgoing:outgoing,funded:'0',lots:[{id:wallet,quantity:'1000000',cost,at:ms-age}]});
 const input={programId:P,config:C,roundId:'1',snapshotAt:at,sourceSlot:10,commitment:'finalized',availableLamports:'850000000',positions:[position(W,'2000000000',900000),position(C,'2000000000',899999),position(P,'3000000000',900000,true)],reference:{confirmed:true,historyComplete:true,spotQ:'1000000000000000',samples:[{at:ms-900000,priceQ:'1000000000000000'},{at:ms,priceQ:'1000000000000000'}]}};
 const out=buildRound(input);assert.equal(out.claims.length,1);assert.equal(out.claims[0].wallet,W);assert.equal(out.total,'850000000');
 assert.throws(()=>buildRound({...input,commitment:'processed'}));assert.throws(()=>buildRound({...input,reference:{...input.reference,historyComplete:false}}));
 input.positions[0].funded='1000000000';assert.throws(()=>buildRound(input),/No payable/);
});
