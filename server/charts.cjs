'use strict';
// Display data only. Never imported by rewards pricing, eligibility or payments.
const {isAddress}=require('../netlify/functions/chain.cjs');
const SOL='So11111111111111111111111111111111111111112';
const INTERVALS=Object.freeze({'1m':['minute',1,60],'5m':['minute',5,300],'15m':['minute',15,900],'1h':['hour',1,3600],'4h':['hour',4,14400],'1d':['day',1,86400]});
class ChartError extends Error{constructor(status,message){super(message);this.status=status;}}
const invalid=()=>new ChartError(502,'The market provider returned invalid chart data.');
const positive=x=>Number.isFinite(Number(x))&&Number(x)>0;
function selectPool(data,mint){
 if(!Array.isArray(data))throw invalid();
 const choices=data.filter(p=>p.type==='pool'&&p.id==='solana_'+p.attributes?.address&&isAddress(p.attributes.address)&&p.relationships?.base_token?.data?.id==='solana_'+mint&&p.relationships?.quote_token?.data?.id==='solana_'+SOL&&positive(p.attributes.reserve_in_usd));
 const pump=p=>['pump-fun','pumpfun','pumpswap'].includes(p.relationships.dex?.data?.id)?1:0;
 const value=x=>positive(x)?Number(x):0;
 choices.sort((a,b)=>pump(b)-pump(a)||value(b.attributes.volume_usd?.h24)-value(a.attributes.volume_usd?.h24)||value(b.attributes.reserve_in_usd)-value(a.attributes.reserve_in_usd)||a.id.localeCompare(b.id));
 return choices[0]||null;
}
function candlesFrom(data,mint,step,now){
 if(data.meta?.base?.address!==mint||data.meta?.quote?.address!==SOL)throw invalid();
 const list=data.data?.attributes?.ohlcv_list;
 if(!Array.isArray(list)||list.length>1000)throw invalid();
 const seen=new Set();
 return list.map(row=>{
  if(!Array.isArray(row)||row.length!==6||row.some(n=>typeof n!=='number'||!Number.isFinite(n)))throw invalid();
  const [time,open,high,low,close,volume]=row;
  if(!Number.isSafeInteger(time)||time<=0||time%step!==0||time>Math.floor(now/1000)||seen.has(time)||low<=0||high<low||open<low||open>high||close<low||close>high||volume<0)throw invalid();
  seen.add(time);return{time,open,high,low,close,volume};
 }).sort((a,b)=>a.time-b.time);
}
function makeService({fetchImpl=globalThis.fetch,now=Date.now}={}){
 const cache=new Map(),pending=new Map();let requests=[];
 async function get(path,ttl){
  const hit=cache.get(path);if(hit&&hit.until>now())return hit.value;
  if(pending.has(path))return pending.get(path);
  const task=(async()=>{
   requests=requests.filter(t=>now()-t<60000);
   if(requests.length>=25)throw new ChartError(429,'Chart updates are busy. Please retry in a minute.');
   requests.push(now());
   const response=await fetchImpl('https://api.geckoterminal.com/api/v2'+path,{headers:{accept:'application/json;version=20230302'},redirect:'error',signal:AbortSignal.timeout(12000)});
   let value=null;
   if(response.status!==404){
    if(!response.ok)throw new ChartError(response.status===429?429:502,'The chart provider is temporarily unavailable. Please retry shortly.');
    const reader=response.body.getReader(),decoder=new TextDecoder();let text='',length=0;
    while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;if(length>1000000){await reader.cancel();throw invalid();}text+=decoder.decode(chunk.value,{stream:true});}
    text+=decoder.decode();value=JSON.parse(text);
   }
   if(cache.size>=400)cache.delete(cache.keys().next().value);
   cache.set(path,{until:now()+ttl,value});return value;
  })();
  pending.set(path,task);try{return await task;}finally{pending.delete(path);}
 }
 return async function chart({mint,interval='15m',currency='usd'}){
  if(!isAddress(mint)||!Object.hasOwn(INTERVALS,interval)||!['usd','sol'].includes(currency))throw new ChartError(400,'Choose a valid Solana mint, chart interval and currency.');
  const [timeframe,aggregate,step]=INTERVALS[interval];
  const listing=await get('/networks/solana/tokens/'+mint+'/pools?page=1',60000);
  const pool=listing?selectPool(listing.data,mint):null;
  const result={mint,interval,currency:currency.toUpperCase(),volumeCurrency:currency.toUpperCase(),source:'GeckoTerminal',checkedAt:new Date(now()).toISOString(),candles:[],pool:null,state:'awaiting_market'};
  if(!pool)return{...result,message:'Waiting for an indexed SOL-paired market for this exact mint.'};
  result.pool={address:pool.attributes.address,name:pool.attributes.name,dex:pool.relationships.dex?.data?.id,url:'https://www.geckoterminal.com/solana/pools/'+pool.attributes.address};
  const data=await get('/networks/solana/pools/'+pool.attributes.address+'/ohlcv/'+timeframe+'?'+new URLSearchParams({aggregate:String(aggregate),limit:'500',currency:currency==='sol'?'token':'usd',token:mint,include_empty_intervals:'false'}),30000);
  if(!data)return{...result,state:'awaiting_trades',message:'This market does not have chart history yet.'};
  result.candles=candlesFrom(data,mint,step,now());result.symbol=String(data.meta.base.symbol||'Token').slice(0,32);
  result.lastTradeBucket=result.candles.at(-1)?.time||null;
  result.state=result.candles.length?'available':'awaiting_trades';
  result.message=result.candles.length?'Provider-indexed trades; gaps mean no reported trades.':'Waiting for reported trades in this market.';
  return result;
 };
}
module.exports={makeService,ChartError,selectPool,candlesFrom,INTERVALS,SOL};
