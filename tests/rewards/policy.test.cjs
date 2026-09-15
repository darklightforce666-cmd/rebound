'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),P=require('../../server/rewards/policy.cjs'),W=require('../../server/rewards/wire.cjs');
const {Keypair}=require('@solana/web3.js');const pub=()=>Keypair.generate().publicKey.toBase58();
test('separate 10, 0.8 and 6.3 SOL receipts and repeated tiny collections conserve 85/15',()=>{
 for(const[n,h,o]of [['10000000000','8500000000','1500000000'],['800000000','680000000','120000000'],['6300000000','5355000000','945000000']]){const x=P.split(n);assert.equal(x.holders,BigInt(h));assert.equal(x.operations,BigInt(o));}
 let r=0n,h=0n,o=0n;for(let i=0;i<100;i++){const x=P.split(1,r);r=x.remainder;h+=x.holders;o+=x.operations;}assert.deepEqual([h,o,r],[85n,15n,0n]);
});
test('609 loss and 328 holder budget: floor lamports, retain dust, never split net budget again',()=>{
 const losses=[329,28,110,48,94];const x=P.allocate(losses.map((n,i)=>({wallet:String(i),outcome:'eligible',loss:BigInt(n)*1000000000n})),328000000000n);
 assert.deepEqual(x.awards.map(a=>(Number(a.amount)/1e9).toFixed(2)),['177.20','15.08','59.24','25.85','50.63']);assert.equal(x.reserved+x.remainder,328000000000n);assert.ok(x.awards.every(a=>a.amount<=a.loss));
 assert.equal(P.split(328000000000n).holders,278800000000n);
});
test('zero losses, excess budget and insufficiency keep funds in holder reserve',()=>{
 assert.equal(P.allocate([],100).remainder,100n);assert.equal(P.allocate([{wallet:'a',outcome:'eligible',loss:10}],100).reserved,10n);assert.equal(P.allocate([{wallet:'a',outcome:'eligible',loss:100}],10).reserved,10n);
});
const observations=()=>Array.from({length:31},(_,i)=>({time:i*60,slot:i,base:'1000000000',realQuote:'10000000000',virtualQuote:'20000000000',quoteModel:'curve',market:'curve',canonical:true,finalized:true,asset:'native-SOL'}));
test('elapsed-time weighting and correct virtual reserve model; higher spot/TWAP',()=>{
 const o=observations();o.at(-1).virtualQuote='30000000000';const r=P.price(o,1800,{complete:true,throughTime:1800});assert.equal(r.twap,20n*P.Q);assert.equal(r.spot,30n*P.Q);assert.equal(r.q,r.spot);
 const amm=o.map(x=>({...x,virtualQuote:'0',quoteModel:'amm'}));assert.equal(P.price(amm,1800,{complete:true,throughTime:1800}).q,10n*P.Q);
});
test('missing coverage, stale prices, low liquidity and graduation discontinuity hold',()=>{
 const complete={complete:true,throughTime:1800};const o=observations();assert.equal(P.price(o,1800,{}).outcome,'hold');assert.equal(P.price(o.slice(1),1800,complete).outcome,'hold');assert.equal(P.price(o.slice(0,-1),1800,complete).outcome,'hold');
 assert.equal(P.price(o.map(x=>({...x,realQuote:'1'})),1800,complete).outcome,'hold');o[20].market='amm';assert.equal(P.price(o,1800,complete).outcome,'hold');
});
test('reference prices reject artificial spike circuit breaker',()=>{const o=observations();o.at(-1).virtualQuote='100000000000';assert.equal(P.price(o,1800,{complete:true,throughTime:1800}).reason,'price_circuit_breaker');});
test('mature lots only; active unpaid awards suppress duplicate compensation',()=>{
 const args={wallet:'a',mint:'m',cutoff:1800,priceQ:P.Q,paid:1,reserved:2,coverage:{complete:true},holdings:7};
 const lots=[{id:'old',wallet:'a',mint:'m',quantity:7,cost:10,maturesAt:1800,asset:'native-SOL',continuouslyHeld:true},{id:'new',wallet:'a',mint:'m',quantity:10,cost:100,maturesAt:1801,asset:'native-SOL',continuouslyHeld:true}];
 assert.equal(P.position(lots,args).loss,0n);assert.equal(P.position(lots,{...args,reserved:0}).loss,2n);assert.equal(P.position(lots,{...args,disqualification:{kind:'sale',event:'exit'}}).outcome,'disqualified');
});
const current=()=>({coverage:{complete:true},price:{outcome:'pass'},position:{outcome:'eligible',reserved:3,cost:10,value:7,paid:1,quantity:7}});
const clock={nowSlot:100,checkedThrough:98,issuedSlot:100};
test('candidate excludes itself; other reservations and previous payments reduce cap',()=>{
 const r=P.paymentCheck({maximum:2},current(),clock);assert.equal(r.payable,1n);assert.equal(r.released,1n);assert.equal(r.outcome,'reduce');
});
test('sale cancels; price recovery cancels without permanent ban; missing data holds',()=>{
 assert.equal(P.paymentCheck({maximum:2},{...current(),disqualification:{kind:'exit',event:'sale'}},clock).permanent,true);
 const c=current();c.position.value=10;assert.equal(P.paymentCheck({maximum:2},c,clock).permanent,false);
 const held=P.paymentCheck({maximum:2},{...c,coverage:{complete:false}},clock);assert.equal(held.outcome,'hold');assert.equal(held.released,undefined);
 assert.equal(P.paymentCheck({maximum:2},{...current(),uncertainBroadcast:true},clock).outcome,'hold');
});
test('lag boundary and retry expiry fail closed',()=>{
 assert.notEqual(P.paymentCheck({maximum:2},current(),{nowSlot:100,checkedThrough:4,issuedSlot:100}).outcome,'hold');
 assert.equal(P.paymentCheck({maximum:2},current(),{nowSlot:100,checkedThrough:3,issuedSlot:100}).outcome,'hold');
 assert.equal(P.paymentCheck({maximum:2},current(),{nowSlot:121,checkedThrough:98,issuedSlot:100}).outcome,'hold');
});
const funding=()=>({purchase:{id:'buy',wallet:'B',cost:'1000000000',time:3000000},recipientHistory:{complete:true,startTime:0,independentFunds:'100000000',firstActivityProven:true,firstActivity:2999900,independentOutflows:0},transfers:Array.from({length:10},(_,i)=>({id:'f'+i,from:'A',to:'B',time:2999990,amount:'80000000',asset:'native-SOL',complete:true,spentByPurchase:'buy',sourceClassification:'private-wallet-verified'}))});
test('split transfers aggregate into material dependent funding',()=>{const r=P.fundingEdges(funding());assert.equal(r.edges.length,1);assert.equal(r.edges[0].amount,800000000n);});
test('dust, unsolicited gifts, services and reward recipients cannot merge holders',()=>{
 const x=funding();x.recipientHistory.independentFunds='2000000000';assert.equal(P.fundingEdges(x).edges.length,0);x.recipientHistory.independentFunds='0';x.transfers.forEach(t=>t.amount='1');assert.equal(P.fundingEdges(x).edges.length,0);
 const s=funding();s.services=[{address:'A',classification:'exchange',verified:true,evidence:'verified-service-account'}];assert.equal(P.fundingEdges(s).edges.length,0);
 s.services[0].classification='unknown';assert.equal(P.fundingEdges(s).edges.length,1,'unknown service labels never exempt a counterparty');
 const r=funding();r.transfers.forEach(t=>t.isReward=true);assert.equal(P.fundingEdges(r).edges.length,0);
});
test('unknown counterparties or incomplete funding history hold purchases, never assert control',()=>{
 const x=funding();x.transfers.forEach(t=>t.sourceClassification='unknown');const r=P.fundingEdges(x);assert.equal(r.edges.length,0);assert.equal(r.holds[0].reason,'material_funding_unresolved');
 x.recipientHistory.complete=false;assert.equal(P.fundingEdges(x).holds[0].reason,'funding_history_incomplete');
});
test('earlier supported links respond to later sale; directional mint-scoped paths and corrections',()=>{
 const edges=[{id:'ab',source:'A',recipient:'B',mint:'m',status:'supported'},{id:'bc',source:'B',recipient:'C',mint:'m',status:'supported'}];
 assert.equal(P.linkedExclusion('C','m',edges,[]),null);assert.deepEqual(P.linkedExclusion('C','m',edges,[{id:'exit',wallet:'A',mint:'m'}]).edges,['ab','bc']);
 assert.equal(P.linkedExclusion('A','m',edges,[{id:'exit',wallet:'C',mint:'m'}]),null);assert.equal(P.linkedExclusion('C','other',edges,[{id:'exit',wallet:'A',mint:'m'}]),null);edges[0].revoked=true;assert.equal(P.linkedExclusion('C','m',edges,[{id:'exit',wallet:'A',mint:'m'}]),null);
});
test('purchase requires attributable creator fee, canonical venue and acceptable entry impact',()=>{
 const e={id:'trade',mint:'m',owner:'a',success:true,finalized:true,complete:true,provenanceComplete:true,quoteAsset:'native-SOL',venue:'pump-curve',canonical:true,creator:'intake',creatorFee:1,quantity:10,actualQuote:10,unavoidableFees:1,prePriceQ:P.Q,time:0,slot:1};
 assert.equal(P.qualifyPurchase(e,{mint:'m',expectedCreator:'intake'}).lot.cost,11n);assert.equal(P.qualifyPurchase({...e,venue:'side-pool'},{mint:'m'}).outcome,'unrecognized');assert.equal(P.qualifyPurchase({...e,provenanceComplete:false},{mint:'m'}).outcome,'hold');assert.equal(P.qualifyPurchase({...e,actualQuote:100},{mint:'m',expectedCreator:'intake'}).reason,'entry_price_impact_limit');
});
test('Merkle sum proofs bind deployment/mint/round/recipient/amount and preserve odd totals',()=>{
 const c={program:pub(),deployment:pub(),mint:pub(),policy:P.POLICY_HASH,round:1};const awards=[1,2,3].map((n,index)=>({wallet:pub(),amount:BigInt(n),index}));const t=W.tree(c,awards);assert.equal(t.root.sum,6n);for(const a of t.allocations)assert.ok(W.verifyProof(c,a,t.root));
 for(const override of [{mint:pub()},{program:pub()},{deployment:pub()},{round:2}])assert.equal(W.verifyProof({...c,...override},t.allocations[0],t.root),false);assert.equal(W.verifyProof(c,{...t.allocations[0],amount:2n},t.root),false);
});
