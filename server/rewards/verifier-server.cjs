'use strict';
const http=require('node:http');
const {Connection,Transaction}=require('@solana/web3.js');
const DB=require('./db.cjs'),C=require('./config.cjs'),W=require('./wire.cjs'),P=require('./policy.cjs'),I=require('./indexer.cjs'),Internal=require('./internal.cjs'),V=require('./verifier.cjs'),Receipts=require('./receipts.cjs'),Delivery=require('./delivery.cjs');
async function start(){
 const cfg=C.settings(),db=DB.connect(process.env.VERIFIER_DATABASE_URL||process.env.DATABASE_URL),connection=new Connection(cfg.rpc,'finalized'),rpc=new I.Rpc(cfg.historyRpc||cfg.rpc);
 const verifier=await C.keyFromFile('REWARDS_VERIFIER_KEY_FILE',cfg.verifier);
 const server=http.createServer(async(req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(P.stable(value));};
  try{
   if(req.method==='GET'&&req.url==='/health')return reply(200,{service:'rebound-verifier',mode:cfg.mode,policy:P.POLICY_HASH});
   if(req.method!=='POST')return reply(405,{message:'Method not allowed'});
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)return reply(413,{message:'Request too large'});chunks.push(chunk);}const body=Buffer.concat(chunks).toString('utf8');
   await Internal.authenticate(db,{method:req.method,path:req.url,headers:req.headers,body},process.env.REWARDS_INTERNAL_SECRET);
   const data=JSON.parse(body),preflight=await C.preflight(connection,db,cfg);
   if(req.url==='/manifest')return reply(200,await V.verifyManifest({db,connection,program:cfg.program,mint:data.mint,round:data.round,cutoff:data.cutoff,published:data.published}));
   // Signing is disabled until all production deployment checks pass.
   C.requireProduction(preflight,cfg);
   if(req.url==='/exit')return reply(200,await require('./exits.cjs').authorize({db,connection,program:cfg.program,verifier,mint:data.mint,wallet:data.wallet}));
   if(req.url==='/payment')return reply(200,await V.authorizePayment({db,connection,rpc,program:cfg.program,verifier,mint:data.mint,round:data.round,index:data.index}));
   if(req.url==='/receipt')return reply(200,await Receipts.authorizeReceipt({db,connection,program:cfg.program,verifier,receiptId:data.receiptId}));
   if(req.url==='/fund'){
    const verified=await V.verifyManifest({db,connection,program:cfg.program,mint:data.mint,round:data.round,cutoff:data.cutoff,published:data.published});if(verified.empty)throw Error('Empty manifest cannot be funded');
    const tx=Transaction.from(Buffer.from(data.transaction,'base64'));
    const expected=W.fund(cfg.program,tx.feePayer,cfg.publisher,cfg.verifier,verified.manifest.context,verified.root,data.cutoff,verified.hash);
    if(tx.instructions.length!==1||!tx.instructions[0].data.equals(expected.data)||P.stable(tx.instructions[0].keys)!==P.stable(expected.keys)||!tx.instructions[0].programId.equals(expected.programId))throw Error('Funding transaction differs from verified manifest');
    tx.partialSign(verifier);return reply(200,{transaction:tx.serialize({requireAllSignatures:false}).toString('base64'),verification:verified.verification});
   }
   if(req.url==='/claim'){
    // Independently available fallback relay. It uses the same fresh check and
    // operations-funded fee payer as scheduled delivery, with fixed recipients.
    const payer=await C.keyFromFile('REWARDS_CLAIM_PAYER_KEY_FILE',cfg.claimPayer);
    const result=await Delivery.deliver({db,connection,cfg,preflight,payer,mint:data.mint,round:data.round,index:data.index,verify:async(route,payload)=>{if(route!=='/payment')throw Error('Unsupported verifier request');return V.authorizePayment({db,connection,rpc,program:cfg.program,verifier,mint:payload.mint,round:payload.round,index:payload.index});}});return reply(200,result);
   }
   reply(404,{message:'Unknown endpoint'});
  }catch(e){await DB.audit(db,'verifier_request_failed',{reason:e.message.replace(/https?:\/\/\S+/g,'[endpoint]')},{actor:'verifier'}).catch(()=>{});reply(503,{message:'Verification unavailable; reservations remain held.'});}
 });
 server.listen(Number(process.env.PORT||8788),process.env.BIND_ADDRESS||'127.0.0.1');return{server,db};
}
if(require.main===module)start().catch(()=>{console.error('Verifier startup failed; check server configuration.');process.exitCode=1;});
module.exports={start};
