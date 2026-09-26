'use strict';
// Independent verifier for V3 rounds (spec §6, §10.1). Runs as a separate process/role with its
// own read-only database role and its own verifier key. Before co-signing a Fund transaction it
// recomputes the snapshot from finalized evidence, rebuilds the Merkle-sum manifest and requires
// exact equality of snapshot hash, root and total, and that the transaction contains exactly one
// Fund instruction carrying those values. It never re-evaluates a frozen award against later
// market prices or holdings.
const S=require('./snapshot-v3.cjs'),W3=require('./wire-v3.cjs'),P3=require('./policy-v3.cjs');

function fundArgs(data){const b=Buffer.from(data);if(b[0]!==W3.TAG.Fund||b.length!==1+8+40+4+8+32+32)return null;
 return{cycle:b.readBigUInt64LE(1),rootHash:b.subarray(9,41).toString('hex'),rootSum:b.readBigUInt64LE(41),count:b.readUInt32LE(49),cutoffSlot:b.readBigUInt64LE(53),snapshot:b.subarray(61,93).toString('hex'),manifest:b.subarray(93,125).toString('hex')};}

/**
 * @param v.db        verifier's read-only connection
 * @param v.program   program id; v.key verifier Keypair
 * @param v.inputs    (coinRow, cycle, cutoff, cutoffSlot) → evidence inputs (independently loaded)
 * @param v.holderReserve (row) → lamports H the proposal was allowed to use
 */
function cosigner(v){
 return async(tx,proposal)=>{
  const row=(await v.db.query('SELECT c.*,p.hash AS policy_hash FROM reward_cycles c JOIN reward_policies p ON p.version=c.policy_version WHERE c.id=$1',[proposal.cycleId])).rows[0];
  if(!row)throw Object.assign(Error('Unknown cycle'),{code:'VERIFIER_REJECTED'});
  const coinRow=(await v.db.query('SELECT * FROM reward_coins WHERE mint=$1',[row.mint])).rows[0];
  const inputs=await v.inputs(coinRow,Number(row.cycle_number),Number(row.cutoff_time),Number(row.cutoff_slot));
  const snap=S.build({...inputs,mint:row.mint,cycle:Number(row.cycle_number),cutoff:Number(row.cutoff_time),cutoffSlot:Number(row.cutoff_slot),holderReserve:row.holder_reserve_lamports,policy:P3.policy(row.policy_version)});
  if(snap.state!=='ready'||snap.snapshotHash!==row.snapshot_hash||snap.snapshotHash!==proposal.snapshotHash)throw Object.assign(Error('Independent snapshot differs'),{code:'VERIFIER_REJECTED'});
  const ctx={program:v.program,deployment:W3.addresses(v.program).deployment,mint:row.mint,policy:row.policy_hash,cycle:row.cycle_number};
  const tr=W3.tree(ctx,snap.awards.map(a=>({index:a.index,wallet:a.owner,amount:a.lamports})));
  const root=`${tr.root.hash.toString('hex')}:${tr.root.sum}`;if(root!==row.root||root!==proposal.root)throw Object.assign(Error('Independent manifest root differs'),{code:'VERIFIER_REJECTED'});
  const funds=tx.instructions.filter(i=>i.programId.equals(W3.pk(v.program))).map(i=>fundArgs(i.data));
  if(funds.length!==1||!funds[0])throw Object.assign(Error('Transaction must contain exactly one Fund instruction'),{code:'VERIFIER_REJECTED'});
  const f=funds[0];
  if(f.cycle!==BigInt(row.cycle_number)||f.rootHash!==tr.root.hash.toString('hex')||f.rootSum!==tr.root.sum||f.count!==snap.awards.length||f.snapshot!==snap.snapshotHash||f.cutoffSlot!==BigInt(row.cutoff_slot))
   throw Object.assign(Error('Fund arguments differ from the verified proposal'),{code:'VERIFIER_REJECTED'});
  tx.partialSign(v.key);
 };
}
module.exports={cosigner,fundArgs};
