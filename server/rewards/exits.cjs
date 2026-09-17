'use strict';
const P=require('./policy.cjs'),W=require('./wire.cjs'),S=require('./snapshot.cjs'),I=require('./indexer.cjs'),DB=require('./db.cjs'),V=require('./verifier.cjs'),T=require('./transport.cjs'),Internal=require('./internal.cjs');
async function authorize({db,connection,program,verifier,mint,wallet}){
 const exit=(await db.query('SELECT d.*,e.signature,e.transaction_index FROM reward_disqualifications d JOIN reward_events e ON e.id=d.event WHERE d.mint=$1 AND d.wallet=$2',[mint,wallet])).rows[0];if(!exit)return{outcome:'hold',reason:'no_confirmed_exit'};
 const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0],cutoff=await S.finalizedCutoff(db,connection);
 const tx=await connection.getParsedTransaction(exit.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx||tx.meta?.err||tx.slot!==Number(exit.slot))throw Error('Exit execution unavailable');
 const parsed=I.parseTransaction(I.plain(tx),{slot:tx.slot,time:tx.blockTime,transactionIndex:Number(exit.transaction_index),coins:[coin]});
 if(!parsed.events.some(e=>e.id===exit.event&&e.owner===wallet&&['sale','transfer_exit','burn','owner_change'].includes(e.kind)))throw Error('Exit was not independently established');
 const position=await S.chainPosition(connection,program,mint,wallet);if(position.disqualified)return{outcome:'recorded'};
 const issued=await connection.getSlot('confirmed');if(issued-cutoff.slot>P.POLICY.indexLagSlots)return{outcome:'hold',reason:'index_lag'};
 const auth={domain:'RBD2EXIT',program,deployment:W.addresses(program,mint).deployment.toBase58(),mint,wallet,round:0,index:0,maximum:0,payable:0,cost:0,value:0,holding:0,through:cutoff.slot,issued,expires:issued+P.POLICY.authorizationSlots,version:position.version,epoch:0,outcome:1,evidence:exit.event};
 const message=W.paymentMessage(auth);await DB.audit(db,'exit_authorized',{event:exit.event,signature:exit.signature,through:cutoff.slot,version:position.version},{mint,wallet,actor:'verifier'});
 return{outcome:'record',authorization:auth,message:message.toString('base64'),signature:V.sign(verifier,message).toString('base64'),verifier:verifier.publicKey.toBase58()};
}
async function publish(context,mint,wallet){
 const {db,connection,cfg,payer}=context,position=await S.chainPosition(connection,cfg.program,mint,wallet);if(position.disqualified)return{state:'finalized'};
 const checked=await Internal.call('/exit',{mint,wallet});if(checked.outcome!=='record')return{state:'held',reason:checked.reason};const a=checked.authorization;
 if(checked.verifier!==cfg.verifier||a.program!==cfg.program||a.mint!==mint||a.wallet!==wallet)throw Error('Exit authorization mismatch');
 return T.submit({...context,job:'exit:'+mint+':'+wallet,instructions:[W.attest(cfg.verifier,W.paymentMessage(a),Buffer.from(checked.signature,'base64')),W.recordExit(cfg.program,payer.publicKey,a)],context:{mint,wallet,evidence:a.evidence},readSettlement:async()=>{const p=await S.chainPosition(connection,cfg.program,mint,wallet);return p.disqualified?{settled:true,...p}:{definitivelyUnsettled:true};}});
}
module.exports={authorize,publish};
