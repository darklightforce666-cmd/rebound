'use strict';
const crypto=require('node:crypto'),W=require('./wire.cjs'),P=require('./policy.cjs'),DB=require('./db.cjs'),S=require('./snapshot.cjs'),H=require('./history.cjs');
function sign(keypair,message){const key=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(keypair.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});return crypto.sign(null,message,key);}
function manifestFor(snapshot,program,round){
 if(!snapshot.complete)throw Error('Cannot fund incomplete inputs: '+snapshot.reason);
 const positions=snapshot.positions.map(p=>p.linkedExclusion||p.chain.disqualified?{...p,outcome:'disqualified'}:p);
 const allocated=P.allocate(positions,snapshot.treasury.unallocated);if(!allocated.awards.length)return{empty:true,reason:'no_eligible_loss',allocated};
 const context={program,deployment:W.addresses(program,snapshot.coin.mint).deployment.toBase58(),mint:snapshot.coin.mint,policy:P.POLICY_HASH,round:String(round)};
 const tree=W.tree(context,allocated.awards.map(p=>({index:p.index,wallet:p.wallet,amount:p.amount})));
 const manifest={version:2,context,cutoff:snapshot.cutoff,inputDigest:snapshot.digest,total:tree.root.sum,root:tree.root.hash.toString('hex'),allocations:tree.allocations.map(a=>({...a,proof:a.proof.map(x=>({hash:x.hash.toString('hex'),sum:x.sum})),lotIds:allocated.awards.find(p=>p.wallet===a.wallet).lotIds}))};
 return{manifest,hash:W.hash(P.stable(manifest)).toString('hex'),root:tree.root,allocated};
}
async function verifyManifest({db,connection,program,mint,round,cutoff,published}){
 if(Number(round)!==Math.floor(cutoff.time/1800))throw Error('Round cutoff mismatch');
 // This process rebuilds raw execution history, holdings, prices and funding
 // status independently. It never signs a supplied arbitrary root/total.
 const snapshot=await S.snapshot(db,connection,{mint,cutoff,program});const expected=manifestFor(snapshot,program,round);
 if(expected.empty)return expected;if(expected.hash!==published.hash||P.stable(expected.manifest)!==P.stable(published.manifest))throw Error('Independent manifest verification differs');
 return{...expected,verification:{inputDigest:snapshot.digest,checkedAt:new Date().toISOString(),cutoff,policy:P.POLICY_HASH}};
}
async function authorizePayment({db,connection,rpc,program,verifier,mint,round,index}){
 const allocation=(await db.query('SELECT * FROM reward_allocations WHERE mint=$1 AND round_id=$2 AND leaf_index=$3',[mint,round,index])).rows[0];if(!allocation)return{outcome:'hold',reason:'allocation_not_registered'};
 if(BigInt(allocation.active)===0n)return{outcome:'settled',signature:allocation.settlement_signature};
 const pending=(await db.query("SELECT * FROM reward_payment_attempts WHERE mint=$1 AND round_id=$2 AND leaf_index=$3 AND state IN ('prepared','broadcast','uncertain')",[mint,round,index])).rows[0];if(pending)return{outcome:'hold',reason:'prior_broadcast_requires_reconciliation'};
 let cutoff;try{cutoff=await S.finalizedCutoff(db,connection);}catch(e){return{outcome:'hold',reason:e.message};}const {slot:checkedThrough,time}=cutoff;
 const snapshot=await S.snapshot(db,connection,{mint,cutoff:{slot:checkedThrough,time},program});if(!snapshot.complete)return{outcome:'hold',reason:snapshot.reason};
 const p=snapshot.positions.find(p=>p.wallet===allocation.wallet);if(!p)return{outcome:'hold',reason:'qualifying_position_unavailable'};
 const currentAccounts=p.tokens.accounts.map(x=>x.address);const historical=[...snapshot.replay.owners].filter(([,x])=>x.owner===allocation.wallet&&x.mint===mint).map(([address])=>address);
 const newer=await H.newerActivity(rpc,[allocation.wallet,...currentAccounts,...historical],checkedThrough);if(newer.hold)return{outcome:'hold',reason:newer.reason,evidence:newer};
 const a=W.addresses(program,mint,round,allocation.wallet,index);
 const [coinInfo,posInfo,awardInfo]=await connection.getMultipleAccountsInfo([a.coin,a.position,a.allocation],'finalized');
 if([coinInfo,posInfo,awardInfo].some(v=>!v?.owner.equals(W.pk(program))))throw Error('Payment account owner mismatch');
 const coin=W.decode(coinInfo.data,'coin'),pos=W.decode(posInfo.data,'position'),award=W.decode(awardInfo.data,'allocation');
 if(award.settled)return{outcome:'settled',reason:'onchain_settlement_needs_reconciliation'};
 if(coin.pendingRegistrations!==0n)return{outcome:'hold',reason:'round_registration_incomplete'};
 if(pos.version!==p.chain.version||pos.active!==p.chain.active||pos.paid!==p.chain.paid)return{outcome:'hold',reason:'position_changed_during_check'};
 const issued=await connection.getSlot('confirmed');
 const current={coverage:{complete:true},price:snapshot.reference,position:{...p,reserved:pos.active,paid:pos.paid},disqualification:p.disqualification?{kind:'exit',event:p.disqualification.event}:pos.disqualified?{kind:'exit',event:pos.firstExit}:null,linkBlock:p.linkedExclusion};
 const check=P.paymentCheck({maximum:award.maximum},current,{nowSlot:issued,issuedSlot:issued,checkedThrough});if(check.outcome==='hold')return check;
 const evidence={inputDigest:snapshot.digest,check,positionVersion:pos.version,fundingEpoch:coin.fundingEpoch,cutoff:snapshot.cutoff};
 const auth={program,deployment:a.deployment.toBase58(),mint,round,index,wallet:allocation.wallet,maximum:award.maximum,payable:check.payable,cost:check.cost||0n,value:check.value||0n,holding:check.holding||0n,through:checkedThrough,issued,expires:issued+P.POLICY.authorizationSlots,version:pos.version,epoch:coin.fundingEpoch,outcome:check.permanent?1:p.linkedExclusion?3:check.outcome==='pass'?0:2,evidence:W.hash(P.stable(evidence))};
 const message=W.paymentMessage(auth),signature=sign(verifier,message),id=W.hash(message).toString('hex');
 return DB.transaction(db,async tx=>{
  await DB.lockPosition(tx,mint,allocation.wallet);
  let live=(await tx.query("SELECT * FROM reward_authorizations WHERE mint=$1 AND wallet=$2 AND position_version=$3 AND funding_epoch=$4 AND state='issued'",[mint,allocation.wallet,String(pos.version),String(coin.fundingEpoch)])).rows[0];
  if(live&&Number(live.expires_slot)<issued){await tx.query("UPDATE reward_authorizations SET state='expired' WHERE id=$1",[live.id]);live=null;}
  // One authorization per position snapshot. The same payload may be relayed;
  // conflicting allocations must wait for settlement or a new state nonce.
  if(live&&live.id!==id)return{outcome:'hold',reason:'position_authorization_already_issued',expires:Number(live.expires_slot)};
  if(!live)await tx.query('INSERT INTO reward_authorizations(id,mint,wallet,round_id,leaf_index,position_version,funding_epoch,checked_through,expires_slot,payload,signature,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,mint,allocation.wallet,round,index,String(pos.version),String(coin.fundingEpoch),checkedThrough,auth.expires,P.stable({...auth,evidence:auth.evidence.toString('hex')}),signature.toString('base64'),P.stable(evidence)]);
  return{...check,id,authorization:{...auth,evidence:auth.evidence.toString('hex')},message:message.toString('base64'),signature:signature.toString('base64'),verifier:verifier.publicKey.toBase58(),tokenAccounts:currentAccounts,evidence};
 });
}
module.exports={sign,manifestFor,verifyManifest,authorizePayment};
