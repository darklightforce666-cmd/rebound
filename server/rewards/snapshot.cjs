'use strict';
const P=require('./policy.cjs'),W=require('./wire.cjs'),I=require('./indexer.cjs'),Project=require('./project.cjs');
const {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID}=require('@solana/spl-token');
async function finalizedCutoff(db,connection){
 const checkpoint=(await db.query("SELECT * FROM reward_checkpoints WHERE name='finalized-blocks'")).rows[0];
 if(!checkpoint?.complete||checkpoint.incident)throw Error('Complete finalized index unavailable');
 const head=await connection.getSlot('finalized'),slot=Number(checkpoint.through_slot),time=Number(checkpoint.through_time);
 if(slot>head||head-slot>P.POLICY.indexLagSlots||!Number.isSafeInteger(time))throw Error('Finalized index outside freshness policy');
 return{slot,time};
}
async function replayCoin(db,coin,cutoff){
 const checkpoint=(await db.query("SELECT * FROM reward_checkpoints WHERE name='finalized-blocks'")).rows[0];
 if(!checkpoint?.complete||checkpoint.incident||Number(checkpoint.through_slot)<cutoff.slot||Number(checkpoint.start_slot)>Number(coin.launch_slot)||coin.blocked_reason)return{complete:false,reason:coin.blocked_reason||'indexing_incomplete'};
 const deployment=(await db.query('SELECT genesis FROM reward_deployments WHERE id=$1',[coin.deployment])).rows[0];if(!deployment)return{complete:false,reason:'deployment_genesis_unavailable'};
 const rows=(await db.query('SELECT * FROM reward_raw_blocks WHERE genesis=$1 AND slot>=$2 AND slot<=$3 ORDER BY slot',[deployment.genesis,coin.launch_slot,cutoff.slot])).rows;
 if(!rows.length||Number(rows[0].slot)!==Number(coin.launch_slot))return{complete:false,reason:'launch_block_unavailable'};
 let owners=new Map(),prior=null;const events=[],holds=[];
 for(const row of rows){
  if(W.hash(P.stable(row.payload)).toString('hex')!==row.digest||prior!==null&&Number(row.parent_slot)!==prior)return{complete:false,reason:'raw_history_integrity_incident'};
  prior=Number(row.slot);for(const[index,tx]of row.payload.transactions.entries()){
   const result=I.parseTransaction(tx,{slot:Number(row.slot),time:Number(row.block_time),transactionIndex:index,coins:[coin],ownership:owners});owners=result.ownership;events.push(...result.events);holds.push(...result.holds);
  }
 }
 if(holds.some(h=>!h.wallet))return{complete:false,reason:'execution_provenance_incomplete',holds};
 const projection=Project.project(events,coin);
 if(projection.holds.some(h=>!h.wallet))return{complete:false,reason:projection.holds.find(h=>!h.wallet).reason,holds:projection.holds};
 // A full finalized block scan proves no intervening change to the bonding
 // curve reserves between decoded trade events. Emit elapsed-time observations.
 // AMM vault donations/boost changes need their explicit state projection.
 const observations=[];let at=0,state=null;const changes=projection.observations.sort((a,b)=>a.slot-b.slot);
 for(const row of rows){while(at<changes.length&&changes[at].slot<=Number(row.slot)){state=changes[at++];if(state.invalidated)observations.push(state);}if(state&&!state.invalidated)observations.push({...state,time:Number(row.block_time),slot:Number(row.slot),evidence:{state:state.evidence,unchangedThrough:row.digest}});}
 return{complete:true,through:cutoff.slot,throughTime:Number(rows.at(-1).block_time),...projection,positionHolds:holds,events,observations,owners,rawDigest:W.hash(...rows.map(r=>Buffer.from(r.digest,'hex'))).toString('hex')};
}
async function chainPosition(connection,program,mint,wallet){
 const a=W.addresses(program,mint,0,wallet);
 const result=await connection.getAccountInfoAndContext(a.position,'finalized');
 if(!result.value)return{version:0n,paid:0n,active:0n,disqualified:0,slot:result.context.slot};
 if(!result.value.owner.equals(W.pk(program)))throw Error('Position owner mismatch');return{...W.decode(result.value.data,'position'),slot:result.context.slot};
}
async function tokenAccounts(connection,wallet,mint){
 const rows=[];for(const programId of [TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID]){
  const r=await connection.getParsedTokenAccountsByOwner(W.pk(wallet),{programId},'finalized');
  for(const a of r.value){const i=a.account.data.parsed.info;if(i.mint===mint&&i.owner===wallet)rows.push({address:a.pubkey.toBase58(),amount:P.int(i.tokenAmount.amount),slot:r.context.slot});}
 }return{accounts:rows,quantity:P.sum(rows.map(x=>x.amount))};
}
async function snapshot(db,connection,{mint,cutoff,program}){
 const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0];if(!coin)return{complete:false,reason:'coin_not_enrolled'};
 const Pump=require('./pump.cjs'),addresses=W.addresses(program,mint);if(coin.intake!==addresses.intake.toBase58()||coin.treasury!==addresses.coin.toBase58()||coin.sharing_config!==Pump.SDK.feeSharingConfigPda(W.pk(mint)).toBase58()||coin.policy_hash!==P.POLICY_HASH)return{complete:false,reason:'coin_configuration_mismatch'};
 let routing;try{routing=await Pump.verifyRouting(connection,program,mint);}catch{return{complete:false,reason:'current_fee_routing_unverified'};}
 const replay=await replayCoin(db,coin,cutoff);if(!replay.complete)return replay;
 await require('./project.cjs').materialize(db,coin);
 const freshFunding=await require('./funding.cjs').refresh({db,rpc:new I.Rpc(process.env.HISTORY_RPC_URL||process.env.SOLANA_RPC_URL),coin,replay,cutoff});
 const reference=P.price(replay.observations,cutoff.time,{complete:true,throughTime:replay.throughTime});if(reference.outcome!=='pass')return{complete:false,reason:reference.reason,replay};
 const links=freshFunding.links;
 const positions=[];
 for(const wallet of [...new Set(replay.lots.map(l=>l.wallet))].sort()){
  const chain=await chainPosition(connection,program,mint,wallet),tokens=await tokenAccounts(connection,wallet,mint);
  if(replay.positionHolds.some(h=>h.wallet===wallet)){positions.push({wallet,outcome:'hold',reason:'holding_history_unresolved',chain,tokens});continue;}
  const exit=replay.exits.find(e=>e.wallet===wallet),linked=P.linkedExclusion(wallet,mint,links,replay.exits);
  const funding=freshFunding.wallets.find(f=>f.wallet===wallet);
  if(!funding?.complete||funding.checkedThrough<cutoff.slot){positions.push({wallet,outcome:'hold',reason:'fresh_funding_analysis_required',chain,tokens});continue;}
  const pos=P.position(replay.lots,{wallet,mint,cutoff:cutoff.time,priceQ:reference.q,paid:chain.paid,reserved:chain.active,disqualification:exit,coverage:{complete:true},holdings:tokens.quantity,linkHolds:links.filter(l=>l.status==='ambiguous').map(l=>l.purchase)});
  positions.push({...pos,wallet,chain,tokens,mintDecimals:routing.mintDecimals,linkedExclusion:linked,disqualification:exit});
 }
 const account=await connection.getAccountInfoAndContext(W.addresses(program,mint).coin,'finalized');if(!account.value?.owner.equals(W.pk(program)))throw Error('Coin treasury unavailable');const treasury=W.decode(account.value.data,'coin');
 for(const p of positions)await db.query('INSERT INTO reward_position_views(mint,wallet,checked_slot,checked_time,view) VALUES($1,$2,$3,$4,$5) ON CONFLICT(mint,wallet) DO UPDATE SET checked_slot=EXCLUDED.checked_slot,checked_time=EXCLUDED.checked_time,view=EXCLUDED.view WHERE reward_position_views.checked_slot<=EXCLUDED.checked_slot',[mint,p.wallet,cutoff.slot,cutoff.time,P.stable({...p,reference,checkTime:cutoff.time})]);
 const input={mint,cutoff,policy:P.POLICY_HASH,rawDigest:replay.rawDigest,reference,positions:positions.map(p=>({...p,chain:{...p.chain,slot:undefined},tokens:p.tokens.accounts.map(t=>({...t,slot:undefined}))})),treasury};
 return{complete:true,coin,cutoff,replay,reference,positions,treasury,digest:W.hash(P.stable(input)).toString('hex')};
}
module.exports={finalizedCutoff,replayCoin,chainPosition,tokenAccounts,snapshot};
