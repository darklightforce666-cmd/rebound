'use strict';
// Deterministic projection from successful finalized execution evidence.
const P=require('./policy.cjs'),W=require('./wire.cjs'),Pump=require('./pump.cjs'),DB=require('./db.cjs');
const id=x=>W.hash(P.stable(x)).toString('hex');
function nativeAmount(e,newName,oldName){const n=e[newName];return n!==undefined&&BigInt(n)!==0n?BigInt(n):BigInt(e[oldName]||0);}
function curveTrade(candidate,events,coin){
 const e=candidate.data.event,quantity=P.int(e.tokenAmount),quote=nativeAmount(e,'quoteAmount','solAmount');
 const vq=nativeAmount(e,'virtualQuoteReserves','virtualSolReserves'),vb=P.int(e.virtualTokenReserves),real=nativeAmount(e,'realQuoteReserves','realSolReserves');
 if(!e.isBuy||vq<=quote)return{outcome:'hold',reason:'invalid_curve_trade_reserves'};
 const creator=e.creator,expected=new Set([coin.intake,coin.sharing_config]);
 if(!expected.has(creator))return{outcome:'unrecognized',reason:'creator_destination_mismatch'};
 const vault=Pump.SDK.creatorVaultPda(W.pk(creator)).toBase58(),curve=Pump.SDK.bondingCurvePda(W.pk(coin.mint)).toBase58();
 const root=candidate.data.route;
 const transfers=events.filter(x=>x.signature===candidate.signature&&x.kind==='funding_transfer'&&x.path.startsWith(root+'/')&&x.data.from===candidate.owner);
 const amountTo=to=>P.sum(transfers.filter(x=>x.data.to===to).map(x=>x.data.amount));
 const creatorFee=P.int(e.creatorFee||0),baseFee=P.int(e.fee||0),buybackFee=P.int(e.buybackFee||0);
 if(buybackFee>baseFee||amountTo(curve)!==quote||!transfers.some(x=>x.data.to===vault&&BigInt(x.data.amount)===creatorFee)||amountTo(e.feeRecipient)!==baseFee-buybackFee)return{outcome:'hold',reason:'quote_transfers_do_not_match_trade'};
 if(buybackFee>0n&&!transfers.some(x=>x.data.to!==curve&&x.data.to!==vault&&x.data.to!==e.feeRecipient&&BigInt(x.data.amount)===buybackFee))return{outcome:'hold',reason:'buyback_fee_transfer_unproven'};
 // Pump's buyback portion is carved out of the protocol fee, not added to it.
 // A first-trade creator-vault rent top-up is excluded from acquisition cost.
 const recognized=P.qualifyPurchase({...candidate.data,id:candidate.id,mint:coin.mint,owner:candidate.owner,creator,quantity,actualQuote:quote,unavoidableFees:baseFee+creatorFee,prePriceQ:(vq-quote)*P.Q/(vb+quantity),time:candidate.time,slot:candidate.slot},{mint:coin.mint,expectedCreator:creator});
 return{...recognized,feeAccrual:{id:candidate.id,amount:creatorFee,asset:'native-SOL',vault},observation:{time:candidate.time,slot:candidate.slot,market:curve,quoteModel:'curve',base:vb,realQuote:real,virtualQuote:vq,canonical:true,finalized:true,asset:'native-SOL',evidence:candidate.id}};
}
function curveState(event,coin){const e=event.data.event;if(!e||!e.virtualTokenReserves)return null;return{time:event.time,slot:event.slot,market:Pump.SDK.bondingCurvePda(W.pk(coin.mint)).toBase58(),quoteModel:'curve',base:P.int(e.virtualTokenReserves),realQuote:nativeAmount(e,'realQuoteReserves','realSolReserves'),virtualQuote:nativeAmount(e,'virtualQuoteReserves','virtualSolReserves'),canonical:true,finalized:true,asset:'native-SOL',evidence:event.id};}
function ammTrade(candidate,events,coin){
 const e=candidate.data.event,canonical=Pump.SDK.canonicalPumpPoolPda(W.pk(coin.mint)).toBase58();
 if(e.pool!==canonical)return{outcome:'unrecognized',reason:'noncanonical_purchase_no_qualifying_cost'};
 if(![coin.intake,coin.sharing_config].includes(e.coinCreator))return{outcome:'hold',reason:'amm_creator_destination_mismatch'};
 if(e.virtualQuoteReserves===undefined)return{outcome:'hold',reason:'amm_virtual_reserves_unavailable'};
 const {getAssociatedTokenAddressSync,NATIVE_MINT,TOKEN_PROGRAM_ID}=require('@solana/spl-token');
 const vault=getAssociatedTokenAddressSync(NATIVE_MINT,Pump.SDK.ammCreatorVaultPda(W.pk(e.coinCreator)),true,TOKEN_PROGRAM_ID).toBase58();
 const transfers=events.filter(x=>x.signature===candidate.signature&&x.kind==='quote_transfer'&&x.path.startsWith(candidate.data.route+'/'));
 const fee=P.int(e.coinCreatorFee||0),quote=P.int(e.quoteAmountIn||e.quoteAmountOut||0),lp=P.int(e.lpFee||0),protocol=P.int(e.protocolFee||0),buyback=P.int(e.buybackFee||0),base=P.int(e.poolBaseTokenReserves),real=P.int(e.poolQuoteTokenReserves),virtual=BigInt(e.virtualQuoteReserves);
 const creatorPaid=P.sum(transfers.filter(t=>t.data.destination===vault).map(t=>t.data.amount));
 if(creatorPaid!==fee||buyback>protocol||real+virtual<=0n)return{outcome:'hold',reason:'amm_creator_fee_transfers_unproven'};
 const buy=candidate.kind==='purchase_candidate',quantity=P.int(buy?e.baseAmountOut:e.baseAmountIn);
 let result={outcome:'sale'};
 if(buy){
  const paid=transfers.filter(t=>t.data.source===e.userQuoteTokenAccount&&t.data.from===candidate.owner);
  const toPool=P.sum(paid.filter(t=>t.data.to===canonical).map(t=>t.data.amount));
  const toProtocol=P.sum(paid.filter(t=>t.data.destination===e.protocolFeeRecipientTokenAccount).map(t=>t.data.amount));
  const actual=P.sum(paid.map(t=>t.data.amount));
  const delivered=P.sum(events.filter(t=>t.signature===candidate.signature&&t.kind==='market_delivery'&&t.owner===candidate.owner&&t.path.startsWith(candidate.data.route+'/')).map(t=>t.data.amount));
  if(toPool!==quote+lp||toProtocol!==protocol-buyback||actual!==quote+lp+protocol+fee||actual!==P.int(e.userQuoteAmountIn)||delivered!==quantity)return{outcome:'hold',reason:'amm_quote_or_base_route_unproven'};
  result=P.qualifyPurchase({...candidate.data,id:candidate.id,mint:coin.mint,owner:candidate.owner,creator:e.coinCreator,quantity,actualQuote:quote,unavoidableFees:lp+protocol+fee,creatorFee:fee,prePriceQ:(real+virtual)*P.Q/base,time:candidate.time,slot:candidate.slot},{mint:coin.mint,expectedCreator:e.coinCreator});
 }
 return{...result,feeAccrual:{id:candidate.id,amount:fee,asset:'wrapped-SOL',vault},observation:{time:candidate.time,slot:candidate.slot,market:canonical,quoteModel:'amm',base:buy?base-quantity:base+quantity,realQuote:buy?real+quote+lp:real-quote+lp,virtualQuote:virtual,canonical:true,finalized:true,asset:'native-SOL',evidence:candidate.id}};
}
function project(events,coin){
 const lots=[],exits=[],observations=[],accruals=[],holds=[],receipts=[],conversions=[];let marketState=null;
 const ordered=[...events].sort((a,b)=>a.slot-b.slot||a.transactionIndex-b.transactionIndex||a.order-b.order);
 for(const e of ordered){
  if(e.mint!==coin.mint)continue;
  if(['sale','transfer_exit','burn','owner_change'].includes(e.kind)&&!exits.some(x=>x.wallet===e.owner)){exits.push({wallet:e.owner,mint:coin.mint,event:e.id,id:e.id,kind:e.kind,slot:e.slot});}
  if(e.kind==='sale'&&e.data.marketProgram===Pump.SDK.PUMP_PROGRAM_ID.toBase58()){
   const v=e.data.event,state=curveState(e,coin);if(state)observations.push(state);
   if([coin.intake,coin.sharing_config].includes(v.creator))accruals.push({id:e.id,amount:P.int(v.creatorFee||0),asset:'native-SOL',vault:Pump.SDK.creatorVaultPda(W.pk(v.creator)).toBase58()});
  }
  if(e.kind==='purchase_candidate'){
   let result;
   if(e.data.venue==='pump-curve')result=curveTrade(e,ordered,coin);
   else result=ammTrade(e,ordered,coin);
   if(result.outcome==='qualifying')lots.push({...result.lot,continuouslyHeld:true,provenance:{event:e.id,signature:e.signature,route:e.data.route,raw:e.rawDigest}});
   if(result.outcome==='hold')holds.push({event:e.id,wallet:e.owner,...result});
   if(result.feeAccrual)accruals.push(result.feeAccrual);
   if(result.observation){marketState=result.observation;observations.push(marketState);}
  }
  if(e.kind==='sale'&&e.data.marketProgram===Pump.SDK.PUMP_AMM_PROGRAM_ID.toBase58()){const r=ammTrade(e,ordered,coin);if(r.feeAccrual)accruals.push(r.feeAccrual);if(r.observation){marketState=r.observation;observations.push(marketState);}if(r.outcome==='hold')holds.push({event:e.id,...r});}
  if(['graduation','market_invalidation'].includes(e.kind)){marketState=null;observations.push({time:e.time,slot:e.slot,invalidated:true,evidence:e.id});}
  if(e.kind==='pool_balances'&&marketState?.quoteModel==='amm'){marketState={...marketState,base:P.int(e.data.base),realQuote:P.int(e.data.quote),time:e.time,slot:e.slot,evidence:e.id};observations.push(marketState);}
  if(e.kind==='creator_unwrap'){
   const amount=P.int(e.data.amount),matches=ordered.filter(t=>t.signature===e.signature&&t.kind==='funding_transfer'&&t.path.startsWith(e.data.route+'/')&&t.data.from===e.data.authority&&t.data.to===e.data.vault);
   if(P.sum(matches.map(t=>t.data.amount))===amount)conversions.push({id:e.id,signature:e.signature,path:e.path,slot:e.slot,transactionIndex:e.transactionIndex,order:e.order,source:e.data.source,destination:e.data.vault,amount,from:'wrapped-SOL',to:'native-SOL'});else holds.push({event:e.id,reason:'creator_unwrap_amount_mismatch'});
  }
  if(e.kind==='initial_creator_collection'){
   const v=e.data.event,amount=P.int(v.creatorFee),vault=Pump.SDK.creatorVaultPda(W.pk(coin.intake)).toBase58();
   const transfers=ordered.filter(t=>t.signature===e.signature&&t.kind==='funding_transfer'&&t.path.startsWith(e.data.route+'/')&&t.data.from===vault&&t.data.to===coin.intake);
   if(v.creator===coin.intake&&P.sum(transfers.map(t=>t.data.amount))===amount)receipts.push({id:e.id,event:e.id,mint:coin.mint,signature:e.signature,path:e.path,slot:e.slot,transactionIndex:e.transactionIndex,order:e.order,distributed:amount,sourceVault:vault,asset:'native-SOL'});
  }
  if(e.kind==='creator_distribution'){
   const v=e.data.event,shares=v.shareholders||[];
   if(v.sharingConfig!==coin.sharing_config||shares.length!==1||shares[0].address!==coin.intake||Number(shares[0].shareBps)!==10000){holds.push({event:e.id,reason:'unexpected_fee_distribution'});continue;}
   if(v.quoteMint&&!['11111111111111111111111111111111','So11111111111111111111111111111111111111112'].includes(v.quoteMint)){holds.push({event:e.id,reason:'unsupported_fee_asset'});continue;}
   receipts.push({id:e.id,event:e.id,mint:coin.mint,signature:e.signature,path:e.path,slot:e.slot,transactionIndex:e.transactionIndex,order:e.order,distributed:P.int(v.distributed),sourceVault:Pump.SDK.creatorVaultPda(W.pk(coin.sharing_config)).toBase58(),asset:'native-SOL'});
  }
 }
 for(const lot of lots)if(exits.some(e=>e.wallet===lot.wallet))lot.continuouslyHeld=false;
 return{lots,exits,observations,accruals,receipts,conversions,holds,digest:id({events:ordered.map(e=>e.id),policy:P.POLICY_HASH,parser:'rebound-execution-v2.1'})};
}
async function materialize(db,coin){
 const rows=(await db.query('SELECT * FROM reward_events WHERE mint=$1 OR kind=$2 ORDER BY slot,transaction_index,execution_order',[coin.mint,'funding_transfer'])).rows;
 const events=rows.map(e=>({...e,path:e.instruction_path,eventIndex:e.event_index,time:e.data.time,transactionIndex:e.transaction_index,order:e.execution_order,rawDigest:e.raw_digest}));const output=project(events,coin);
 await DB.transaction(db,async tx=>{
  for(const lot of output.lots){await DB.lockPosition(tx,lot.mint,lot.wallet);await tx.query('INSERT INTO reward_purchase_lots(id,mint,wallet,quantity,cost,quote_asset,bought_at,matures_at,slot,continuously_held,status,policy_hash,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING',[lot.id,lot.mint,lot.wallet,String(lot.quantity),String(lot.cost),lot.asset,lot.at,lot.maturesAt,lot.slot,lot.continuouslyHeld,'recognized',lot.policy,P.stable(lot.provenance)]);}
  for(const hold of output.holds)await DB.audit(tx,'projection_hold',hold,{mint:coin.mint,wallet:hold.wallet||null});
  if(output.holds.some(h=>!h.wallet))await tx.query('UPDATE reward_coins SET blocked_reason=$2 WHERE mint=$1',[coin.mint,output.holds.find(h=>!h.wallet).reason]);
 });return output;
}
module.exports={curveTrade,curveState,ammTrade,project,materialize};
