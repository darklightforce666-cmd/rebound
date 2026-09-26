/* Live mainnet interface. Transactions stay unavailable until fee routing and rewards are deployed. */
(()=>{
'use strict';
const C=window.ReboundConfig,D=window.ReboundData,$=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=a=>a.slice(0,6)+'…'+a.slice(-5);
const external=(url,label,classes='btn outline small')=>'<a class="'+classes+'" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+' ↗</a>';
const usd=raw=>raw==null||raw===''||!Number.isFinite(Number(raw))||Number(raw)<0?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:6}).format(Number(raw));
let renderId=0,controller=null,unlocked=false,primary=C.mint,admin=false,siteName=null;
const legacyWallet=({onChange})=>window.ReboundWallet.createWallet({providers:()=>({phantom:window.phantom?.solana,solflare:window.solflare}),isAddress:D.isAddress,onChange});
const onWallet=()=>{admin=false;updateWallet();if(unlocked)render();window.ReboundV3?.isAdmin().then(a=>{admin=a;updateAdminNav();});};
const wallet=window.ReboundV3?window.ReboundV3.initWallet({onChange:onWallet,fallback:legacyWallet}):legacyWallet({onChange:onWallet});
function updateAdminNav(){document.querySelectorAll('[data-nav="admin"]').forEach(a=>a.hidden=!admin);}
// The REBOUND token is set from the admin dashboard; every open page follows changes in real time.
function applySite(st){const m=st?.primaryMint;const name=st?.name||null;let changed=false;
 if(m&&D.isAddress(m)&&m!==primary){primary=m;changed=true;}if(name!==siteName){siteName=name;changed=true;}
 const[route='explore']=location.hash.slice(1).split('/');if(changed&&unlocked&&['','explore','analytics','token'].includes(route))render();}
window.ReboundV3?.config().then(c=>{applySite({primaryMint:c.siteSettings?.primaryMint||c.primaryMint,name:c.siteSettings?.name});window.ReboundV3.onSite?.(applySite);}).catch(()=>{});
function toast(text){const n=document.createElement('div');n.className='toast';n.textContent=text;$('#toasts').append(n);setTimeout(()=>n.remove(),6000);}
function updateWallet(){$('.wallet-button').textContent=wallet.address?short(wallet.address):'Connect wallet';}
function notice(text){return '<div class="notice live-notice" role="status">'+esc(text)+'</div>';}
function empty(title,text){return '<div class="live-empty"><h3>'+esc(title)+'</h3><p>'+esc(text)+'</p></div>';}
function heading(title,copy){return '<div class="page-head"><div><h1>'+esc(title)+'</h1><p>'+esc(copy)+'</p></div><button class="btn outline small" data-action="refresh">Refresh data</button></div>';}
function lookup(){return '<form id="mint-search" class="live-search"><label for="mint-address">Find a Solana token</label><div><input id="mint-address" name="mint" autocomplete="off" spellcheck="false" placeholder="Paste token mint address" required maxlength="44"><button class="btn" type="submit">View token</button></div><p id="search-error" role="status"></p></form>';}
function rewardNotice(){return '<section id="rewards-summary" class="card live-card" aria-live="polite"><h2>How REBOUND rewards work</h2><p>Loading…</p></section>';}
function tokenList(){return '<section id="token-list" class="card live-card" aria-live="polite"><h2>REBOUND tokens</h2><p>Loading verified launches…</p></section>';}
function tokenChart(mint){return window.ReboundCharts.markup(mint,mint===primary?'Rebound':'Token');}
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
const COPY_ICON='<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
function tokenCard(mint){return '<section class="card live-card"><div class="live-token-heading"><img class="live-logo" src="assets/rebound-logo.png" alt="rebound"><div><span class="micro-label">REBOUND TOKEN</span><h2 id="configured-name">'+esc(siteName||'REBOUND')+'</h2></div><a href="#token/'+esc(mint)+'" class="btn outline small">View token ↗</a></div><button type="button" class="live-address copy-address" data-action="copy" data-copy="'+esc(mint)+'" title="Copy contract address" aria-label="Copy contract address '+esc(mint)+'"><span>'+esc(mint)+'</span>'+COPY_ICON+'</button><div id="configured-status" aria-live="polite">Checking mainnet…</div><div id="configured-market" aria-live="polite">Loading market data…</div></section>';}
function explore(){return '<section class="hero live-hero"><div class="hero-copy"><h1>Launch a token.<br><em>Reward topblasters.</em></h1><p>A launchpad built around Pump.fun.<br>Creator fees compensate holders who are underwater.</p><div class="hero-actions"><a href="#launch" class="btn">Launch a token ↗</a><a href="#docs" class="btn ghost">How it works</a></div><div class="hero-fineprint">Solana mainnet · Rounds every 30 minutes</div></div><div class="live-hero-mark"><img src="assets/rebound-logo.png" alt="rebound logo"><span>85% underwater holders · 15% buy & burn REBOUND</span></div></section>'+lookup()+tokenList()+tokenCard(primary)+rewardNotice()+tokenChart(primary);}
function launch(){return heading('Launch through Pump.fun','A separate program-controlled fee treasury for every coin.')+'<section id="rewards-launch" class="card live-card"><p>Checking launch availability…</p></section>'+rewardNotice();}
function portfolio(){return heading('Your portfolio','Finalized Solana mainnet balances from your connected wallet.')+(wallet.address?'<section class="card live-card"><div class="section-heading"><h2>Connected wallet</h2>'+external('https://solscan.io/account/'+wallet.address,'View account')+'</div><p class="live-address">'+esc(wallet.address)+'</p><div id="wallet-data" aria-live="polite">Loading your balances…</div></section>':'<section class="card live-card">'+empty('Connect your wallet','See your real SOL and token balances. Connecting does not request a transaction signature.')+'<button class="btn" data-action="wallet">Connect wallet</button></section>')+'<section id="wallet-rewards" class="card live-card" aria-live="polite"></section>'+rewardNotice();}
function analytics(){return heading('Creator fees & rewards','Collected fees, fixed awards, payouts and burns — all with chain evidence.')+rewardNotice()+tokenChart(primary);}
function adminPage(){return heading('Administration','Configuration, funding approval, program actions and live logs.')+'<div id="admin-root" aria-live="polite"><p>Checking administrator access…</p></div>';}
function docs(){return heading('How rebound works','Pump.fun launches. Creator-fee funding. Loss compensation in SOL.')+'<section class="docs-grid"><article class="card live-card"><h3>Pump.fun underneath</h3><p>Pump.fun creates and trades the coins. REBOUND launches regular creator-fee coins whose fees go, from the first trade, to a treasury the REBOUND program controls for that coin only.</p></article><article class="card live-card"><h3>85 / 15, split once</h3><p>Collected creator fees are split once: 85% compensates holders who are still underwater; 15% buys the REBOUND token on its canonical market and burns it. For the REBOUND token itself, its dev wallet funds holders and keeps its 15%. Trading volume is not a reward balance.</p></article><article class="card live-card"><h3>Who is compensated</h3><p>Every 30 minutes a snapshot 60 seconds before the round ends measures each remaining holding: remaining loss = cost of the tokens still held (in USD) − their current value − compensation already paid or reserved. The holder budget is shared in proportion to remaining losses and never exceeds any loss. Selling later does not cancel an award fixed at the snapshot.</p></article><article class="card live-card"><h3>Evidence, not promises</h3><p>Awards are published as an on-chain Merkle-sum root and paid by the program after the round ends; every payment, receipt, buyback and burn links to its transaction. No returns are guaranteed; rounds without funds or without underwater holders pay nothing.</p></article></section><section class="card live-card"><h2>Risks</h2><ul class="live-requirements"><li>Token prices can fall further; compensation is limited to collected fees.</li><li>SOL/USD moves change USD losses even when the token price does not.</li><li>Rounds wait when finalized history or prices are incomplete; they never guess.</li></ul>'+external('https://github.com/pump-fun/pump-public-docs','Pump.fun integration docs')+'</section>';}
function token(mint){
 if(!D.isAddress(mint))return heading('Token unavailable','Use a real Solana mint address.')+empty('This token link is no longer available','Previously saved test tokens are not mainnet assets.')+lookup();
 return heading('Token overview','Mainnet token verification and indexed market data.')+'<section class="card live-card"><div class="section-heading"><h2 id="token-name">'+(mint===primary?'REBOUND token':'Solana token')+'</h2>'+external('https://solscan.io/token/'+mint,'View on Solscan')+'</div><p class="live-address">'+esc(mint)+'</p><div id="mint-status" aria-live="polite">Checking mainnet…</div></section><section class="card live-card"><div id="token-market" aria-live="polite">Loading market data…</div></section><section id="token-rewards" class="card live-card" aria-live="polite"><p>Checking REBOUND rewards…</p></section>'+tokenChart(mint)+rewardNotice()+lookup();
}
async function loadMint(mint,target,nameTarget,id,signal){
 try{
  const data=await chain('mint',mint,signal);if(id!==renderId)return;
  $(target).innerHTML=data.exists?notice('Verified initialized mint on Solana mainnet. Supply: '+D.units(data.supply,data.decimals,6)+'. Checked at finalized slot '+data.slot+'.'):notice('No token mint exists at this address on mainnet yet. Launch and trading are unavailable.');
  if(data.exists&&data.name&&$(nameTarget))$(nameTarget).textContent=data.name;
 }catch(e){if(id===renderId&&e.name!=='AbortError')$(target).innerHTML=notice(e.message);}
}
async function loadMarket(mint,target,id,signal){
 try{
  const pair=await market(mint,signal);if(id!==renderId)return;
  if(!pair){$(target).innerHTML=empty('No indexed market yet','A token chart and price will appear when a real market for this mint is available.');return;}
  const url='https://dexscreener.com/solana/'+pair.pairAddress;
  $(target).innerHTML='<div class="section-heading"><h2>'+esc(pair.baseToken.name||short(mint))+' <span class="live-symbol">'+esc(pair.baseToken.symbol)+'</span></h2>'+external(url,'Open market')+'</div><div class="live-metrics"><div><span>Price</span><strong>'+usd(pair.priceUsd)+'</strong></div><div><span>Market cap</span><strong>'+usd(pair.marketCap)+'</strong></div><div><span>24h volume</span><strong>'+usd(pair.volume?.h24)+'</strong></div><div><span>Liquidity</span><strong>'+usd(pair.liquidity?.usd)+'</strong></div></div><p class="live-caption">Source: DEX Screener · '+esc(pair.dexId)+' · Fetched '+new Date().toLocaleTimeString()+'. Quotes are for reference.</p>'+(['pumpfun','pumpswap'].includes(pair.dexId)?external('https://pump.fun/coin/'+mint,'View on Pump.fun'):'');
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
 const route=['explore','launch','portfolio','analytics','docs','token','admin'].includes(requested)?requested:'explore',pages={explore,launch,portfolio,analytics,docs,admin:adminPage,token:()=>token(mint)};
 $('#main').innerHTML=pages[route]();document.title=(route==='explore'?'':route.charAt(0).toUpperCase()+route.slice(1)+' · ')+'rebound';document.body.dataset.route=route;
 document.querySelectorAll('[data-nav]').forEach(a=>{const active=a.dataset.nav===(route==='token'?'explore':route);a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 document.body.classList.remove('menu-open');updateWallet();window.ReboundCharts.mount({signal});
 if(route==='explore'){loadMint(primary,'#configured-status','#configured-name',id,signal);loadMarket(primary,'#configured-market',id,signal);}
 if(route==='token'&&D.isAddress(mint)){loadMint(mint,'#mint-status','#token-name',id,signal);loadMarket(mint,'#token-market',id,signal);}
 if(route==='portfolio'&&wallet.address)loadWallet(id,signal);
 window.ReboundV3?.mount({route,mint:route==='token'?mint:primary,toast,signal});updateAdminNav();
}
async function walletModal(){
 const privy=!wallet.address&&wallet.privyConfigured?await wallet.privyConfigured():false;
 $('#dialog-body').innerHTML='<div class="dialog-content"><div class="dialog-head"><h2>'+(wallet.address?'Connected wallet':'Connect a wallet')+'</h2><button class="close" data-action="close" aria-label="Close dialog">×</button></div>'+(wallet.address?'<p class="live-address">'+esc(wallet.address)+'</p><a href="#portfolio" class="btn" data-action="close">View portfolio</a><button class="btn outline" data-action="disconnect">Disconnect</button>':privy?'<p>Connecting does not request a transaction. Signing in to launch or to see your awards asks for one message signature that cannot move SOL or tokens.</p><button class="wallet-pick" data-wallet="privy"><b>Connect a Solana wallet</b><span>↗</span></button>':'<p>Connecting does not request a transaction. Signing in to launch or to see your awards asks for one message signature that cannot move SOL or tokens.</p><button class="wallet-pick" data-wallet="phantom"><b>Phantom</b><span>↗</span></button><button class="wallet-pick" data-wallet="solflare"><b>Solflare</b><span>↗</span></button><div class="wallet-get-links">'+external('https://phantom.com/','Get Phantom','text-link')+external('https://solflare.com/','Get Solflare','text-link')+'</div>')+'</div>';
 if(!$('#dialog').open)$('#dialog').showModal();
}
document.addEventListener('click',async event=>{
 const b=event.target.closest('[data-action], [data-wallet]');if(!b)return;
 if(b.dataset.wallet){b.disabled=true;try{if(b.dataset.wallet==='privy')$('#dialog').close();await wallet.connect(b.dataset.wallet);if($('#dialog').open)$('#dialog').close();}catch(e){toast(e.message);}finally{b.disabled=false;}return;}
 switch(b.dataset.action){case'copy':try{await navigator.clipboard.writeText(b.dataset.copy);toast('Contract address copied');}catch{toast('Copy failed — select the address and copy it manually.');}break;case'wallet':walletModal();break;case'close':$('#dialog').close();break;case'disconnect':await wallet.disconnect();$('#dialog').close();break;case'refresh':render();break;case'menu':$('#dialog-body').innerHTML='<div class="dialog-content"><div class="dialog-head"><h2>Navigation</h2><button class="close" data-action="close" aria-label="Close navigation">×</button></div><nav class="live-menu"><a data-action="close" href="#explore">Discover</a><a data-action="close" href="#launch">Launch a token</a><a data-action="close" href="#portfolio">Portfolio</a><a data-action="close" href="#analytics">Analytics</a><a data-action="close" href="#docs">Documentation</a><a data-action="close" href="#admin" data-nav="admin" '+(admin?'':'hidden')+'>Administration</a></nav></div>';$('#dialog').showModal();break;}
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
