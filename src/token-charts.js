/* TradingView renderer; provider data is visual reference, never reward authority. */
(()=>{
'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const intervals=['1m','5m','15m','1h','4h','1d'];
function markup(mint,label){return '<section class="card live-card token-chart-card" data-chart-mint="'+esc(mint)+'"><div class="section-heading"><div><h2>'+esc(label)+' chart</h2><p data-chart-market>TradingView · Loading this token’s market…</p></div><div class="token-chart-controls"><label>Interval <select data-chart-interval aria-label="Chart interval">'+intervals.map(v=>'<option '+(v==='15m'?'selected':'')+'>'+v+'</option>').join('')+'</select></label><label>Price <select data-chart-currency aria-label="Chart price currency"><option value="usd">USD</option><option value="sol">SOL</option></select></label><button class="btn outline small" data-chart-reset>Fit chart</button></div></div><div class="live-chart" data-chart-canvas aria-label="Token candlestick chart"></div><p class="live-caption" data-chart-status role="status">Loading candles…</p><p class="live-caption">Charts by <a class="text-link" href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView Lightweight Charts™</a> · Market data by <a class="text-link" href="https://www.geckoterminal.com/" target="_blank" rel="noopener noreferrer">GeckoTerminal</a>. <span data-chart-volume>Volume in USD.</span> Times in UTC. Display prices do not determine rewards.</p><p class="live-caption"><a class="text-link" href="assets/TRADINGVIEW-NOTICE.txt" target="_blank" rel="noopener noreferrer">Copyright © 2025 TradingView, Inc.</a></p></section>';}
function mount({signal}){
 for(const host of document.querySelectorAll('[data-chart-mint]')){
  const canvas=host.querySelector('[data-chart-canvas]'),status=host.querySelector('[data-chart-status]'),market=host.querySelector('[data-chart-market]');
  const interval=host.querySelector('[data-chart-interval]'),currency=host.querySelector('[data-chart-currency]');
  if(!window.LightweightCharts){status.textContent='The chart library could not load. Refresh this page to retry.';continue;}
  const {createChart,CandlestickSeries,HistogramSeries,ColorType}=window.LightweightCharts;
  const chart=createChart(canvas,{autoSize:true,layout:{background:{type:ColorType.Solid,color:'#0b1410'},textColor:'#a6b4aa',attributionLogo:true},grid:{vertLines:{color:'#1c2b22'},horzLines:{color:'#1c2b22'}},rightPriceScale:{borderColor:'#2c4437',scaleMargins:{top:0.12,bottom:0.25}},timeScale:{timeVisible:true,secondsVisible:false,borderColor:'#2c4437'},localization:{locale:'en-US'}});
  const candles=chart.addSeries(CandlestickSeries,{upColor:'#badd94',downColor:'#ed7979',wickUpColor:'#badd94',wickDownColor:'#ed7979',borderVisible:false});
  const volume=chart.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:''});volume.priceScale().applyOptions({scaleMargins:{top:0.83,bottom:0}});
  let request=null,timer=null,generation=0,seriesKey=null,disposed=false,hasData=false;
  function clear(){candles.setData([]);volume.setData([]);hasData=false;}
  async function refresh(reset=false){
   clearTimeout(timer);request?.abort();request=new AbortController();const id=++generation;
   if(reset){clear();seriesKey=null;status.textContent='Loading candles…';market.textContent='TradingView · Loading this token’s market…';}
   try{
    const response=await fetch('/.netlify/functions/charts?'+new URLSearchParams({mint:host.dataset.chartMint,interval:interval.value,currency:currency.value}),{signal:AbortSignal.any([signal,request.signal,AbortSignal.timeout(28000)])});
    if(!response.headers.get('content-type')?.includes('application/json'))throw Error('Token charts need the Netlify chart service.');
    const data=await response.json();if(!response.ok)throw Error(data.message||'Chart data unavailable.');
    if(id!==generation||disposed)return;
    if(data.mint!==host.dataset.chartMint||data.interval!==interval.value||data.currency!==currency.value.toUpperCase()||!Array.isArray(data.candles))throw Error('The chart response did not match this token.');
    host.querySelector('[data-chart-volume]').textContent='Volume in '+data.volumeCurrency+'.';
    const nextKey=[data.mint,data.pool?.address,data.interval,data.currency].join(':');const fit=nextKey!==seriesKey||!hasData;seriesKey=nextKey;
    if(!data.candles.length){clear();market.textContent='TradingView · '+data.currency;status.textContent=data.message;return;}
    const min=Math.min(...data.candles.map(c=>c.low)),precision=Math.min(16,Math.max(2,Math.ceil(-Math.log10(min))+3));
    // A custom formatter avoids the built-in formatter's integer-base limit
    // when a tiny SOL price needs more than eight fractional digits.
    candles.applyOptions({priceFormat:{type:'custom',minMove:10**-precision,formatter:price=>price.toFixed(precision)}});
    // Bounded 500-bar refresh also reconciles provider revisions to old candles.
    candles.setData(data.candles.map(({time,open,high,low,close})=>({time,open,high,low,close})));
    volume.setData(data.candles.map(c=>({time:c.time,value:c.volume,color:c.close>=c.open?'#badd9440':'#ed797940'})));hasData=true;
    if(fit)chart.timeScale().fitContent();
    market.innerHTML=esc((data.symbol||'Token')+' / '+data.currency+' · '+data.pool.dex)+' · <a class="text-link" href="'+esc(data.pool.url)+'" target="_blank" rel="noopener noreferrer">View source market ↗</a>';
    status.textContent='Last trade candle: '+new Date(data.lastTradeBucket*1000).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC · Checked '+new Date(data.checkedAt).toLocaleTimeString()+'. '+data.message;
   }catch(e){if(id===generation&&!disposed&&e.name!=='AbortError')status.textContent=(hasData?'Update delayed; displayed candles are from the previous check. ':'')+(e.name==='TimeoutError'?'The chart request timed out. Retrying shortly.':e.message);}
   finally{if(!disposed&&id===generation)timer=setTimeout(()=>{if(document.hidden)timer=setTimeout(()=>refresh(),60000);else refresh();},60000);}
  }
  interval.onchange=currency.onchange=()=>refresh(true);host.querySelector('[data-chart-reset]').onclick=()=>chart.timeScale().fitContent();
  signal.addEventListener('abort',()=>{disposed=true;clearTimeout(timer);request?.abort();chart.remove();},{once:true});
  refresh();
 }
}
window.ReboundCharts={markup,mount};
})();
