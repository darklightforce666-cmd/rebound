// Input must come from an independently verified, finalized activity indexer.
// This tool calculates policy and proofs; it does not fetch or attest chain history.
const fs=require('node:fs'),E=require('../../src/engine.cjs'),M=require('./merkle.cjs');
function buildRound(input) {
  const {programId,config,roundId,snapshotAt,positions,reference,availableLamports,sourceSlot}=input;
  M.key(programId);M.key(config);M.amount(roundId);
  if(!Number.isSafeInteger(snapshotAt)||snapshotAt<=0||!Number.isSafeInteger(sourceSlot)||sourceSlot<0||input.commitment!=='finalized') throw Error('A finalized slot and integer snapshot time are required');
  const at=snapshotAt*1000;if(!Number.isSafeInteger(at))throw Error('Invalid snapshot time');
  const available=M.amount(availableLamports);
  if(!Array.isArray(positions)||!positions.length||positions.length>65536)throw Error('Invalid holder set');
  const seen=new Set();
  const parsed=positions.map(p=>{
    M.key(p.wallet);if(seen.has(p.wallet))throw Error('Duplicate holder');seen.add(p.wallet);
    if(typeof p.hasOutgoing!=='boolean'||!Array.isArray(p.lots))throw Error('Incomplete position');
    const ids=new Set();
    const lots=p.lots.map(l=>{if(typeof l.id!=='string'||!l.id||ids.has(l.id)||!Number.isSafeInteger(l.at)||l.at<0||l.at>at)throw Error('Invalid or repeated purchase');ids.add(l.id);return {...l,quantity:M.amount(l.quantity),cost:M.amount(l.cost)};});
    return {...p,lots,funded:M.amount(p.funded)};
  });
  const ref=E.checkedReference({...reference,at,samples:reference.samples.map(s=>({...s,priceQ:M.amount(s.priceQ)})),spotQ:M.amount(reference.spotQ)});
  const losses=parsed.map(p=>E.shortfall(p,ref,at));
  const allocation=E.allocate(available,losses);
  if(!allocation.distributed)throw Error('No payable recorded losses or no available funds');
  const tree=M.build(programId,config,roundId,allocation.allocations);
  const manifest={version:1,policy:'holder-recovery/v2',programId,config,roundId:String(roundId),snapshotAt,sourceSlot,commitment:'finalized',referencePriceQ:ref.priceQ.toString(),inputHash:M.hash(JSON.stringify(input)).toString('hex'),root:tree.root,total:tree.total,awards:tree.claims.map(c=>({wallet:c.wallet,amount:c.amount}))};
  return {...manifest,manifestHash:M.hash(JSON.stringify(manifest)).toString('hex'),claims:tree.claims};
}
module.exports={buildRound};
if(require.main===module){try{if(process.argv.length!==4)throw Error('Usage: node build-round.cjs verified-snapshot.json round.json');const out=buildRound(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));fs.writeFileSync(process.argv[3],JSON.stringify(out,null,2)+'\n');console.log('Prepared '+out.claims.length+' awards totalling '+out.total+' lamports. No transactions sent.');}catch(e){console.error(e.message);process.exitCode=1;}}
