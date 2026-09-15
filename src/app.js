/* Live mainnet interface. Transactions stay unavailable until fee routing and rewards are deployed. */
(()=>{
'use strict';
const C=window.ReboundConfig,D=window.ReboundData,$=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=a=>a.slice(0,6)+'…'+a.slice(-5);
const external=(url,label,classes='btn outline small')=>'<a class="'+classes+'" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+' ↗</a>';
const usd=raw=>raw==null||raw===''||!Number.isFinite(Number(raw))||Number(raw)<0?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:6}).format(Number(raw));
let renderId=0,controller=null,unlocked=false;
const wallet=window.ReboundWallet.createWallet({providers:()=>({phantom:window.phantom?.solana,solflare:window.solflare}),isAddress:D.isAddress,onChange:()=>{updateWallet();if(unlocked)render();}});
function toast(text){const n=document.createElement('div');n.className='toast';n.textContent=text;$('#toasts').append(n);setTimeout(()=>n.remove(),6000);}
function updateWallet(){$('.wallet-button').textContent=wallet.address?short(wallet.address):'Connect wallet';}
function notice(text){return '<div class="notice live-notice" role="status">'+esc(text)+'</div>';}
function empty(title,text){return '<div class="live-empty"><h3>'+esc(title)+'</h3><p>'+esc(text)+'</p></div>';}
function heading(title,copy){return '<div class="page-head"><div><h1>'+esc(title)+'</h1><p>'+esc(copy)+'</p></div><button class="btn outline small" data-action="refresh">Refresh data</button></div>';}
function lookup(){return '<form id="mint-search" class="live-search"><label for="mint-address">Find a Solana token</label><div><input id="mint-address" name="mint" autocomplete="off" spellcheck="false" placeholder="Paste token mint address" required maxlength="44"><button class="btn" type="submit">View token</button></div><p id="search-error" role="status"></p></form>';}
function rewardNotice(){return '<section id="rewards-summary" class="card live-card" aria-live="polite"><h2>Creator fees & rewards</h2><p>Checking the reward service…</p></section>';}
function solChart(){return '<section class="card live-card"><div class="section-heading"><div><h2>Solana market</h2><p>SOL / USD · Coinbase · TradingView</p></div></div><div id="sol-chart" class="live-chart"></div><p class="live-caption">This is the SOL market, separate from the selected token. '+external('https://www.tradingview.com/symbols/SOLUSD/','Open TradingView','text-link')+'</p></section>';}
function mountSolChart(){
 const host=$('#sol-chart');if(!host)return;
 const container=document.createElement('div');container.className='tradingview-widget-container';container.style.cssText='height:100%;width:100%';
 const widget=document.createElement('div');widget.className='tradingview-widget-container__widget';widget.style.cssText='height:calc(100% - 32px);width:100%';
 const attribution=document.createElement('div');attribution.className='tradingview-widget-copyright';attribution.innerHTML='<a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Track all markets on TradingView</a>';
 const script=document.createElement('script');script.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';script.async=true;
 script.textContent=JSON.stringify({autosize:true,symbol:C.solChartSymbol,interval:'60',timezone:'Etc/UTC',theme:'dark',style:'1',locale:'en',allow_symbol_change:true,calendar:false,support_host:'https://www.tradingview.com'});
 script.onerror=()=>{if(host.isConnected)host.innerHTML=empty('Chart unavailable','TradingView could not load. Use the link below or retry.');};
 container.append(widget,attribution,script);host.append(container);
}
async function chain(action,address,signal){
 let response;
 try{response=await fetch(C.chainEndpoint+'?'+new URLSearchParams({action,...(address?{address}:{})}),{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),cache:'no-store'});}
 catch(e){if(e.name==='AbortError')throw e;throw Error('Live Solana data is unavailable. Please retry.');}
 if(!response.headers.get('content-type')?.includes('application/json'))throw Error('Live wallet and token checks need the Netlify deployment. This host does not provide the Solana connection.');
 const json=await response.json();if(!response.ok)throw Error(typeof json.message==='string'?json.message:'Live Solana data is unavailable.');return json;
}
async function market(mint,signal){
 const response=await fetch('https://api.dexscreener.com/token-pairs/v1/solana/'+mint,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 if(!response.ok)throw Error('Market data could not be loaded. Please retry.');
 return D.selectPair(await response.json(),mint);
}
function tokenCard(mint){return '<section class="card live-card"><div class="live-token-heading"><img class="live-logo" src="assets/rebound-logo.png" alt="rebound"><div><span class="micro-label">CONFIGURED TOKEN</span><h2 id="configured-name">Initial token</h2></div><a href="#token/'+mint+'" class="btn outline small">View token ↗</a></div><p class="live-address">'+mint+'</p><div id="configured-status" aria-live="polite">Checking mainnet…</div><div id="configured-market" aria-live="polite">Loading market data…</div></section>';}
function explore(){return '<section class="hero live-hero"><div class="hero-copy"><h1>Launch a token.<br><em>Reward topblasters.</em></h1><p>A launchpad built around Pump.fun.<br>Creator fees will fund SOL rewards for holders.</p><div class="hero-actions"><a href="#launch" class="btn">Launch status ↗</a><a href="#docs" class="btn ghost">How it works</a></div><div class="hero-fineprint">Mainnet data · Creator fee rewards in preparation</div></div><div class="live-hero-mark"><img src="assets/rebound-logo.png" alt="rebound logo"><span>85% holders · 15% operations</span></div></section>'+lookup()+tokenCard(C.mint)+rewardNotice()+solChart();}
function launch(){return heading('Launch through Pump.fun','A separate SOL reward treasury for every coin.')+'<section id="rewards-launch" class="card live-card"><p>Checking launch availability…</p></section>'+rewardNotice();}
function portfolio(){return heading('Your portfolio','Finalized Solana mainnet balances from your connected wallet.')+(wallet.address?'<section class="card live-card"><div class="section-heading"><h2>Connected wallet</h2>'+external('https://solscan.io/account/'+wallet.address,'View account')+'</div><p class="live-address">'+esc(wallet.address)+'</p><div id="wallet-data" aria-live="polite">Loading your balances…</div></section>':'<section class="card live-card">'+empty('Connect your wallet','See your real SOL and token balances. Connecting does not request a transaction signature.')+'<button class="btn" data-action="wallet">Connect wallet</button></section>')+rewardNotice();}
function analytics(){return heading('Creator fees & rewards','Verified reserves, conditional allocations and completed payments.')+rewardNotice()+solChart();}
function docs(){return heading('How rebound works','Pump.fun launches. Creator fee funding. SOL rewards.')+'<section class="docs-grid"><article class="card live-card"><h3>Pump.fun underneath</h3><p>Pump.fun handles token creation and trading. REBOUND is the interface and rewards layer. Coins start on a bonding curve and can later graduate to PumpSwap.</p></article><article class="card live-card"><h3>Creator fee funding</h3><p>Rewards come from creator fees actually collected from connected tokens. The split is 85% for holders and 15% for operations. Trading volume is not the reward balance.</p></article><article class="card live-card"><h3>Reward policy</h3><p>The current reward-program design uses recorded losses and available fees. Purchases mature after 30 minutes; a sale or outgoing transfer ends future rewards. Scheduled 30-minute rounds require verified history and prices.</p><p>These payouts are not active yet.</p></article><article class="card live-card"><h3>What you can test now</h3><p>Browse live market data and TradingView charts. On the Netlify deployment, connect a wallet to read balances and verify token addresses. Launches, trades within REBOUND, fee claims, and payouts remain unavailable.</p></article></section><section class="card live-card"><h2>Activation requirements</h2><ul class="live-requirements"><li>A live Netlify deployment with the private mainnet RPC configured.</li><li>A real Pump.fun mint and verified creator-fee recipient.</li><li>The deployed REBOUND reward program and initialized reward vault.</li><li>Verified trade history, fee collection, reward calculations, and a running payout service.</li></ul><p>There are no preset returns, guaranteed refunds, or generated reward balances.</p>'+external('https://github.com/darklightforce666-cmd/rebound/blob/main/docs/REWARDS-V2.md','Deployment details')+external('https://github.com/pump-fun/pump-public-docs','Pump.fun integration docs')+'</section>';}
function token(mint){
 if(!D.isAddress(mint))return heading('Token unavailable','Use a real Solana mint address.')+empty('This token link is no longer available','Previously saved test tokens are not mainnet assets.')+lookup();
 return heading('Token overview','Mainnet token verification and indexed market data.')+'<section class="card live-card"><div class="section-heading"><h2 id="token-name">'+(mint===C.mint?'Configured token':'Solana token')+'</h2>'+external('https://solscan.io/token/'+mint,'View on Solscan')+'</div><p class="live-address">'+esc(mint)+'</p><div id="mint-status" aria-live="polite">Checking mainnet…</div></section><section class="card live-card"><div id="token-market" aria-live="polite">Loading market data…</div></section>'+rewardNotice()+lookup();
}
async function loadMint(mint,target,nameTarget,id,signal){
 try{
  const data=await chain('mint',mint,signal);if(id!==renderId)return;
  $(target).innerHTML=data.exists?notice('Verified initialized mint on Solana mainnet. Supply: '+D.units(data.supply,data.decimals,6)+'. Checked at finalized slot '+data.slot+'.'):notice('No token mint exists at this address on mainnet yet. Launch and trading are unavailable.');
  if(data.exists&&data.name&&$(nameTarget))$(nameTarget).textContent=data.name;
 }catch(e){if(id===renderId&&e.name!=='AbortError')$(target).innerHTML=notice(e.message);}
}
async function loadMarket(mint,target,detail,id,signal){
 try{
  const pair=await market(mint,signal);if(id!==renderId)return;
  if(!pair){$(target).innerHTML=empty('No indexed market yet','A token chart and price will appear when a real market for this mint is available.');return;}
  const url='https://dexscreener.com/solana/'+pair.pairAddress;
  $(target).innerHTML='<div class="section-heading"><h2>'+esc(pair.baseToken.name||short(mint))+' <span class="live-symbol">'+esc(pair.baseToken.symbol)+'</span></h2>'+external(url,'Open market')+'</div><div class="live-metrics"><div><span>Price</span><strong>'+usd(pair.priceUsd)+'</strong></div><div><span>Market cap</span><strong>'+usd(pair.marketCap)+'</strong></div><div><span>24h volume</span><strong>'+usd(pair.volume?.h24)+'</strong></div><div><span>Liquidity</span><strong>'+usd(pair.liquidity?.usd)+'</strong></div></div><p class="live-caption">Source: DEX Screener · '+esc(pair.dexId)+' · Fetched '+new Date().toLocaleTimeString()+'. Quotes are for reference.</p>'+(detail?'<iframe class="live-chart token-chart" title="'+esc(pair.baseToken.symbol||'Token')+' market chart on DEX Screener" src="'+url+'?embed=1&theme=dark&chartTheme=dark&trades=0&info=0" loading="lazy" allow="clipboard-write" referrerpolicy="strict-origin-when-cross-origin"></iframe><p class="live-caption">Chart provided by DEX Screener. '+external(url,'Open chart','text-link')+'</p>':'')+(['pumpfun','pumpswap'].includes(pair.dexId)?external('https://pump.fun/coin/'+mint,'View on Pump.fun'):'');
 }catch(e){if(id===renderId&&e.name!=='AbortError')$(target).innerHTML=empty('Market data unavailable',e.message);}
}
async function loadWallet(id,signal){
 const address=wallet.address;
 try{
  const data=await chain('wallet',address,signal);if(id!==renderId||address!==wallet.address)return;
  $('#wallet-data').innerHTML='<div class="live-balance"><span>SOL balance</span><strong>'+esc(D.units(data.lamports,9,9))+' SOL</strong></div><p class="live-caption">Finalized balances · Updated '+new Date(data.checkedAt).toLocaleTimeString()+'</p>'+(data.tokens.length?'<div class="table-container"><table class="token-table"><thead><tr><th>Token mint</th><th>Balance</th><th></th></tr></thead><tbody>'+data.tokens.map(t=>'<tr><td><a class="live-address" href="#token/'+esc(t.mint)+'">'+esc(short(t.mint))+'</a></td><td>'+esc(D.units(t.amount,t.decimals,9))+'</td><td><a href="#token/'+esc(t.mint)+'">View ↗</a></td></tr>').join('')+'</tbody></table></div>':empty('No token balances','No nonzero SPL Token or Token-2022 balances were returned for this wallet.'));
 }catch(e){if(id===renderId&&e.name!=='AbortError')$('#wallet-data').innerHTML=notice(e.message);}
}
function render(){
 if(!unlocked)return;
 controller?.abort();controller=new AbortController();const signal=controller.signal,id=++renderId;
 const[requested='explore',mint='']=location.hash.slice(1).split('/');
 const route=['explore','launch','portfolio','analytics','docs','token'].includes(requested)?requested:'explore',pages={explore,launch,portfolio,analytics,docs,token:()=>token(mint)};
 $('#main').innerHTML=pages[route]();document.title=(route==='explore'?'':route.charAt(0).toUpperCase()+route.slice(1)+' · ')+'rebound';document.body.dataset.route=route;
 document.querySelectorAll('[data-nav]').forEach(a=>{const active=a.dataset.nav===(route==='token'?'explore':route);a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 document.body.classList.remove('menu-open');updateWallet();mountSolChart();
 if(route==='explore'){loadMint(C.mint,'#configured-status','#configured-name',id,signal);loadMarket(C.mint,'#configured-market',false,id,signal);}
 if(route==='token'&&D.isAddress(mint)){loadMint(mint,'#mint-status','#token-name',id,signal);loadMarket(mint,'#token-market',true,id,signal);}
 if(route==='portfolio'&&wallet.address)loadWallet(id,signal);
 window.ReboundRewards?.mount({route,mint:route==='token'?mint:C.mint,wallet,toast,signal});
}
function walletModal(){
 $('#dialog-body').innerHTML='<div class="dialog-content"><div class="dialog-head"><h2>'+(wallet.address?'Connected wallet':'Connect a wallet')+'</h2><button class="close" data-action="close" aria-label="Close dialog">×</button></div>'+(wallet.address?'<p class="live-address">'+esc(wallet.address)+'</p><a href="#portfolio" class="btn" data-action="close">View portfolio</a><button class="btn outline" data-action="disconnect">Disconnect</button>':'<p>Connect to see your real mainnet balances. No transaction signature is requested.</p><button class="wallet-pick" data-wallet="phantom"><b>Phantom</b><span>↗</span></button><button class="wallet-pick" data-wallet="solflare"><b>Solflare</b><span>↗</span></button><div class="wallet-get-links">'+external('https://phantom.com/','Get Phantom','text-link')+external('https://solflare.com/','Get Solflare','text-link')+'</div>')+'</div>';
 if(!$('#dialog').open)$('#dialog').showModal();
}
document.addEventListener('click',async event=>{
 const b=event.target.closest('[data-action], [data-wallet]');if(!b)return;
 if(b.dataset.wallet){b.disabled=true;try{await wallet.connect(b.dataset.wallet);$('#dialog').close();}catch(e){toast(e.message);}finally{b.disabled=false;}return;}
 switch(b.dataset.action){case'wallet':walletModal();break;case'close':$('#dialog').close();break;case'disconnect':await wallet.disconnect();$('#dialog').close();break;case'refresh':render();break;case'menu':$('#dialog-body').innerHTML='<div class="dialog-content"><div class="dialog-head"><h2>Navigation</h2><button class="close" data-action="close" aria-label="Close navigation">×</button></div><nav class="live-menu"><a data-action="close" href="#explore">Discover</a><a data-action="close" href="#launch">Launch status</a><a data-action="close" href="#portfolio">Portfolio</a><a data-action="close" href="#analytics">Analytics</a><a data-action="close" href="#docs">Documentation</a></nav></div>';$('#dialog').showModal();break;}
});
document.addEventListener('submit',event=>{
 if(event.target.id!=='mint-search')return;event.preventDefault();const mint=$('#mint-address').value.trim();
 if(!D.isAddress(mint)){$('#search-error').textContent='Enter a valid 32-byte Solana mint address.';return;}
 if(location.hash==='#token/'+mint)render();else location.hash='#token/'+mint;
});
window.addEventListener('hashchange',render);
window.addEventListener('rebound:unlocked',()=>{unlocked=true;render();});
if(document.body.classList.contains('rebound-unlocked')){unlocked=true;render();}
})();
