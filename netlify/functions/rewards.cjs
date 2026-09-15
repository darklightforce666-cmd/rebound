'use strict';
const {Connection}=require('@solana/web3.js');
const DB=require('../../server/rewards/db.cjs'),C=require('../../server/rewards/config.cjs'),P=require('../../server/rewards/policy.cjs'),W=require('../../server/rewards/wire.cjs'),Auth=require('../../server/rewards/auth.cjs'),Internal=require('../../server/rewards/internal.cjs');
let pool;
const reply=(statusCode,value)=>({statusCode,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'},body:P.stable(value)});
exports.handler=async event=>{
 const cfg=C.settings(),query=event.queryStringParameters||{},action=query.action||'health';
 try{
  if(event.httpMethod==='GET'&&['metadata','image'].includes(action)){
   const result=await require('../../server/rewards/metadata.cjs').read(query.hash);if(!result)return reply(404,{message:'Metadata not found'});const bytes=Buffer.from(result.data);if(W.hash(bytes).toString('hex')!==query.hash)throw Error('Content hash mismatch');
   return{statusCode:200,headers:{'content-type':result.metadata.mime,'cache-control':'public,max-age=31536000,immutable','x-content-type-options':'nosniff'},body:bytes.toString('base64'),isBase64Encoded:true};
  }
  if(!process.env.DATABASE_URL){if(action==='health')return reply(200,{available:false,transfersEnabled:false,state:'setup_required',reason:'Rewards database is not connected.',policy:P.POLICY,operations:cfg.operations,coins:[]});return reply(503,{message:'Rewards setup is incomplete. No launch or payout is available yet.'});}
  pool||=DB.connect();
  if(event.httpMethod==='GET'){
   if(action==='health'){
    const checkpoint=(await pool.query("SELECT through_slot,through_time,complete,incident,updated_at FROM reward_checkpoints WHERE name='finalized-blocks'")).rows[0];
    const coins=(await pool.query('SELECT mint,treasury,intake,status,blocked_reason,activation_slot,policy_hash FROM reward_coins ORDER BY created_at DESC LIMIT 100')).rows;
    const next=Math.floor(Date.now()/1800000)*1800+1800;
    const ready=cfg.enabled?(await C.preflight(cfg.rpc?new Connection(cfg.rpc,'finalized'):null,pool,cfg)).ready:false;
    const jobs=(await pool.query('SELECT id,mint,kind,state,attempts,lease_until,due_at FROM reward_jobs ORDER BY due_at DESC LIMIT 30')).rows;
    return reply(200,{available:true,transfersEnabled:ready,launchesEnabled:ready,state:ready?'fresh_verification_required':cfg.enabled?'deployment_blocked':'dry_run',reason:cfg.enabled&&!ready?'Deployment verification is incomplete. Reserved funds remain held.':null,policy:P.POLICY,policyHash:P.POLICY_HASH,operations:cfg.operations,program:cfg.program,checkpoint,coins,jobs,nextCycle:next,note:'Every allocation remains conditional until its fresh eligibility check and finalized payment.'});
   }
   if(action==='coin'){
    W.pk(query.mint);const coin=(await pool.query('SELECT c.*,a.* FROM reward_coins c LEFT JOIN reward_accounts a USING(mint) WHERE mint=$1',[query.mint])).rows[0];if(!coin)return reply(404,{message:'This coin has not enrolled in rebound rewards.'});
    const rounds=(await pool.query('SELECT mint,round_id,cutoff_slot,cutoff_time,state,total,manifest_hash,root,funding_signature,reason FROM reward_rounds WHERE mint=$1 ORDER BY round_id DESC LIMIT 30',[query.mint])).rows;
    const payments=(await pool.query('SELECT round_id,leaf_index,wallet,maximum,active,paid,released,state,settlement_signature FROM reward_allocations WHERE mint=$1 ORDER BY round_id DESC,leaf_index LIMIT 100',[query.mint])).rows;
    return reply(200,{coin,rounds,payments,asset:'native-SOL',units:'lamports'});
   }
   if(action==='wallet'){
    W.pk(query.mint);W.pk(query.wallet);const position=(await pool.query('SELECT * FROM reward_position_views WHERE mint=$1 AND wallet=$2',[query.mint,query.wallet])).rows[0];
    const disqualification=(await pool.query('SELECT d.*,e.signature,e.instruction_path FROM reward_disqualifications d JOIN reward_events e ON e.id=d.event WHERE d.mint=$1 AND d.wallet=$2',[query.mint,query.wallet])).rows[0];
    const allocations=(await pool.query('SELECT * FROM reward_allocations WHERE mint=$1 AND wallet=$2 ORDER BY round_id DESC LIMIT 100',[query.mint,query.wallet])).rows;
    return reply(200,{position:position||{view:{outcome:'indexing',reason:'No verified qualifying position is available yet.'}},disqualification,allocations,asset:'native-SOL',units:'lamports'});
   }
   if(action==='round'){
    W.pk(query.mint);if(!/^\d+$/.test(query.round||''))throw Error('Invalid round');const round=(await pool.query('SELECT * FROM reward_rounds WHERE mint=$1 AND round_id=$2',[query.mint,query.round])).rows[0];return reply(round?200:404,round||{message:'Round not found'});
   }
   return reply(404,{message:'Unknown read endpoint'});
  }
  if(event.httpMethod!=='POST')return reply(405,{message:'Method not allowed'});
  if(event.headers.origin!==cfg.origin)return reply(403,{message:'Open this action from rebound.'});
  if(event.isBase64Encoded||Buffer.byteLength(event.body||'')>3000000)return reply(413,{message:'Request too large'});
  const data=JSON.parse(event.body||'{}'),{wallet,payload={}}=data;W.pk(wallet);
  await Auth.rateLimit(pool,'wallet:'+wallet,30);await Auth.rateLimit(pool,'ip:'+(event.headers['x-nf-client-connection-ip']||'unknown'),90);
  if(action==='challenge')return reply(200,await Auth.challenge(pool,{wallet,action:data.action,payload,origin:cfg.origin}));
  await Auth.authenticate(pool,{wallet,action,payload,origin:cfg.origin,proof:data.proof});
  if(action==='metadata-upload')return reply(200,await require('../../server/rewards/metadata.cjs').upload({origin:cfg.origin,name:payload.name,symbol:payload.symbol,description:payload.description,imageBase64:payload.imageBase64}));
  const context={db:pool,connection:new Connection(cfg.rpc,'finalized'),cfg,wallet,payload};
  if(action==='launch-prepare')return reply(200,await require('../../server/rewards/launch.cjs').prepare(context));
  if(action==='launch-next')return reply(200,await require('../../server/rewards/launch.cjs').next(context));
  if(action==='launch-submit')return reply(200,await require('../../server/rewards/launch.cjs').submit(context));
  if(action==='claim'){
   const a=(await pool.query('SELECT wallet FROM reward_allocations WHERE mint=$1 AND round_id=$2 AND leaf_index=$3',[payload.mint,payload.round,payload.index])).rows[0];if(a?.wallet!==wallet)return reply(403,{message:'This reservation belongs to another wallet.'});
   if(!cfg.enabled)return reply(503,{message:'Payments are disabled. The reservation remains held.'});
   return reply(200,await Internal.call('/claim',{mint:payload.mint,round:payload.round,index:payload.index}));
  }
  return reply(404,{message:'Unknown action'});
 }catch(error){return reply(400,{message:typeof error.message==='string'&&!/https?:|postgres|password|secret|key file|ECONN|ENOTFOUND|ENOENT/i.test(error.message)?error.message:'This service is unavailable. Reservations remain held; retry after setup or recovery.'});}
};
