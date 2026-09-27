/* REBOUND V3 browser bundle: wallet (Privy when configured), Supabase session, launch journey,
   live token list, wallet rewards, token cycles and the administrator dashboard.
   Browsers never supply amounts, eligibility, roles or instructions: every transaction shown for
   signing was built and is re-verified by the server; a sign-in or consent signature can never
   move SOL or tokens. */
import {createClient} from '@supabase/supabase-js';
import {Keypair,Transaction} from '@solana/web3.js';
import {signInWithSelectedWallet,verifiedAddresses,onWalletChanged} from './auth/wallet-session.js';
import Seal from '../server/rewards/inbox-seal.cjs';
import {mountHome,mountCheck} from './home.js';

const endpoint='/.netlify/functions/rewards';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=a=>a?String(a).slice(0,4)+'…'+String(a).slice(-4):'';
const sol=n=>{if(n==null||n==='')return '—';const v=BigInt(String(n).split('.')[0]),s=String(v%1000000000n).padStart(9,'0').replace(/0+$/,'');return String(v/1000000000n)+(s?'.'+s.slice(0,6):'')+' SOL';};
const usdPico=n=>{if(n==null)return '—';const x=Number(BigInt(String(n).split('.')[0]))/1e12;return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:6}).format(x);};
const lamportsOf=s=>{const m=/^(\d{1,6})(?:\.(\d{1,9}))?$/.exec(String(s||'0').trim());if(!m)throw Error('Enter a SOL amount like 0.1');return BigInt(m[1])*1000000000n+BigInt((m[2]||'').padEnd(9,'0'));};
const b64=bytes=>{let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);};
const raw=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const tx=(sig,label='View transaction')=>sig&&!/^chain-job/.test(sig)?'<a class="text-link" href="https://solscan.io/tx/'+esc(sig)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+' ↗</a>':'';
const acct=(a,label)=>a?'<a class="text-link live-address" href="https://solscan.io/account/'+esc(a)+'" target="_blank" rel="noopener noreferrer">'+esc(label||short(a))+' ↗</a>':'—';
const when=t=>t?new Date(typeof t==='number'?t*1000:t).toLocaleString():'—';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Secret-key parsing for the key inbox (base58 64-byte export, e.g. Phantom, or a solana-keygen JSON array).
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str){let n=0n;for(const ch of str){const i=B58.indexOf(ch);if(i<0)throw Error('bad');n=n*58n+BigInt(i);}
 const out=[];while(n>0n){out.push(Number(n%256n));n/=256n;}for(const ch of str){if(ch!=='1')break;out.push(0);}return Uint8Array.from(out.reverse());}
function parseSecretKey(text){const t=String(text||'').trim();let bytes;
 try{if(t.startsWith('[')){const a=JSON.parse(t);if(!Array.isArray(a)||a.some(n=>!Number.isInteger(n)||n<0||n>255))throw 0;bytes=Uint8Array.from(a);}else bytes=b58decode(t);}catch{bytes=null;}
 if(!bytes||bytes.length!==64)throw Error('Paste the full private key: a base58 string (Phantom → Export private key) or a [1,2,…] array of 64 numbers.');
 return bytes;}
let cfg=null,supabase=null,session=null,me=null,cfgPromise=null;
// Admin dashboard password session (tab-scoped; 12 h server-side expiry).
const ADMIN_KEY='rebound-admin-session';
const adminToken=()=>{try{return sessionStorage.getItem(ADMIN_KEY)||null;}catch{return null;}};
const setAdminToken=t=>{try{t?sessionStorage.setItem(ADMIN_KEY,t):sessionStorage.removeItem(ADMIN_KEY);}catch{}};
async function api(action,{query={},body,auth=false,signal}={}){
 const headers={};if(body)headers['content-type']='application/json';
 const adm=action.startsWith('admin-')?adminToken():null;
 if(adm)headers['x-admin-session']=adm;
 else if(auth){const t=await accessToken();headers.authorization='Bearer '+t;}
 const r=await fetch(endpoint+'?'+new URLSearchParams({action,...query}),{method:body?'POST':'GET',headers,body:body?JSON.stringify(body,(k,v)=>typeof v==='bigint'?String(v):v):undefined,cache:'no-store',signal});
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error('The REBOUND service is unavailable on this host. Nothing was changed.');
 const data=await r.json();if(!r.ok)throw Object.assign(Error(data.message||'Request failed'),{code:data.code,status:r.status});return data;
}
function config(){return cfgPromise||=api('config').then(c=>{cfg=c;if(c.supabase?.url&&c.supabase?.publishableKey)supabase=createClient(c.supabase.url,c.supabase.publishableKey,{auth:{persistSession:true,storageKey:'rebound-auth',autoRefreshToken:true},realtime:{params:{eventsPerSecond:5}}});return c;}).catch(e=>{cfgPromise=null;throw e;});}

// ---------------- wallet: Privy (configured) or Phantom/Solflare fallback ----------------
function loadScript(src){return new Promise((ok,no)=>{if(document.querySelector('script[data-src="'+src+'"]'))return ok();const s=document.createElement('script');s.src=src;s.dataset.src=src;s.onload=ok;s.onerror=()=>no(Error('Could not load the wallet connector.'));document.head.append(s);});}
function createWallet({onChange,fallback}){
 let current=null,privy=null,legacy=null,waiters=[];
 const set=next=>{const before=current?.address||null;current=next;if((next?.address||null)!==before){onChange(next?.address||null);for(const w of waiters.splice(0))w(next);}};
 const fromPrivy=w=>({kind:'privy',address:w.address,
  async signMessage(bytes){const out=await w.signMessage({message:bytes});return out.signature instanceof Uint8Array?out.signature:new Uint8Array(out.signature);},
  async signTransactionBytes(bytes){const out=await w.signTransaction({transaction:bytes,chain:'solana:mainnet'});return out.signedTransaction instanceof Uint8Array?out.signedTransaction:new Uint8Array(out.signedTransaction);},
  async disconnect(){try{await w.disconnect();}catch{}}});
 async function usePrivy(){
  await config();if(!cfg.privy?.appId)return null;
  if(!privy){await loadScript('src/privy.js?v=1');privy=window.ReboundPrivy.mountPrivy(cfg.privy.appId);privy.listeners.add(b=>{const w=b.wallets[0];set(w?fromPrivy(w):null);});}
  return privy;
 }
 return{
  get address(){return current?.address||null;},
  async privyConfigured(){try{await config();return !!cfg.privy?.appId;}catch{return false;}},
  async connect(which){
   const p=await usePrivy().catch(()=>null);
   if(p){for(let i=0;i<50&&!p.connect;i++)await sleep(100);if(!p.connect)throw Error('The wallet connector is still loading. Try again.');
    const wait=new Promise(r=>waiters.push(r));p.connect();const w=await Promise.race([wait,sleep(180000)]);if(!w)throw Error('No wallet was connected.');return;}
   legacy||=fallback({onChange:addr=>set(addr?{kind:'legacy',address:addr,signMessage:bytes=>legacy.signMessage(new TextDecoder().decode(bytes)).then(x=>x instanceof Uint8Array?x:new Uint8Array(x)),
    signTransactionBytes:async bytes=>(await legacy.signTransaction(Transaction.from(bytes))).serialize({requireAllSignatures:false,verifySignatures:false}),disconnect:()=>legacy.disconnect()}:null)});
   await legacy.connect(which||'phantom');
  },
  async disconnect(){const c=current;set(null);await c?.disconnect?.();if(supabase)await supabase.auth.signOut({scope:'local'}).catch(()=>{});session=null;me=null;},
  async signMessage(message){if(!current)throw Error('Connect your wallet first.');const bytes=typeof message==='string'?new TextEncoder().encode(message):message;const a=current.address,sig=await current.signMessage(bytes);if(current?.address!==a)throw Error('Wallet changed during signing.');return sig;},
  async signTransaction(t){if(!current)throw Error('Connect your wallet first.');const a=current.address,out=await current.signTransactionBytes(t.serialize({requireAllSignatures:false,verifySignatures:false}));if(current?.address!==a)throw Error('Wallet changed during signing.');return Transaction.from(out);},
 };
}
let wallet=null;
function initWallet({onChange,fallback}){wallet=createWallet({onChange:async addr=>{if(supabase)await onWalletChanged(supabase,addr).catch(()=>{});session=null;me=null;onChange(addr);},fallback});return wallet;}

// ---------------- session (SIWS via Supabase) + consent ----------------
async function accessToken(){
 await config();if(!supabase)throw Error('Sign-in is not configured on this host yet.');if(!wallet?.address)throw Error('Connect your wallet first.');
 let s=(await supabase.auth.getSession()).data.session;
 if(!s||!verifiedAddresses(s.user).includes(wallet.address))s=await signInWithSelectedWallet(supabase,{address:wallet.address,signMessage:bytes=>wallet.signMessage(bytes)});
 session=s;return s.access_token;
}
async function whoami(){if(me&&me.wallet===wallet?.address)return me;const r=await api('session',{body:{},auth:true});me={...r,wallet:wallet.address};return me;}
async function consent(action,payload,binding={}){
 const c=await api('consent-challenge',{body:{wallet:wallet.address,action,payload,binding},auth:true});
 const sig=await wallet.signMessage(c.message);return{id:c.id,signature:b64(sig)};
}
async function adminCall(action,payload,binding){if(adminToken())return api(action,{body:{payload}});const proof=await consent(action,payload,binding);return api(action,{body:{wallet:wallet.address,payload,proof},auth:true});}
async function signB64(b64tx,extraSigners=[]){const t=Transaction.from(raw(b64tx));if(extraSigners.length)t.partialSign(...extraSigners);const signed=await wallet.signTransaction(t);return b64(signed.serialize({requireAllSignatures:true,verifySignatures:true}));}

// ---------------- public: policy/health summary ----------------
const POLICY='<p><b>Where the money comes from.</b> Only creator fees that were actually collected, and — for the REBOUND token — SOL the dev wallet really received. Trading volume is not a reward balance.</p><p><b>85 / 15, once.</b> 85 % goes to holders who are still underwater; the split happens once when funding arrives. For launched tokens the other 15 % buys the REBOUND token on its canonical market and <b>burns</b> it. For the REBOUND token itself the 15 % stays with its dev wallet.</p><p><b>Loss in SOL.</b> Remaining loss = the SOL you paid for the tokens you still hold − what they are worth in SOL now − compensation already paid or reserved. Value uses the higher of spot and the 15-minute average price. Tokens received by transfer carry no purchase cost; the SOL/USD rate plays no part.</p><p><b>Hold, don’t sell.</b> A purchase counts once you have held it for 15 minutes. Any sale or transfer of the token to another wallet removes that wallet from all later rounds of the token for good — buying again does not bring it back.</p><p><b>Every 30 minutes.</b> A snapshot 60 seconds before each round fixes every award. Awards are paid at the end of the round and stay payable even if you sell afterwards. No returns are guaranteed.</p>';
async function mountSummary(host,signal){
 try{const h=await api('health',{signal});await config();if(!host.isConnected)return;
  const ns=(cfg.namespaces||[]).map(n=>'<span class="tag neutral">'+esc(n.namespace==='mainnet_test'?'Private test':'Production')+': '+esc(n.executionMode.replace('_',' '))+(n.paused?' · paused':'')+'</span>').join(' ');
  host.innerHTML='<h2>How REBOUND rewards work</h2>'+POLICY+'<p>'+ns+'</p><p class="live-caption">Service: '+esc(h.state.replaceAll('_',' '))+(h.worker?' · worker heartbeat '+when(h.worker.heartbeatAt):'')+' · policy '+esc(h.policy?.version||'')+'</p>';
 }catch(e){if(!signal?.aborted&&host.isConnected)host.innerHTML='<h2>How REBOUND rewards work</h2>'+POLICY+'<p>'+esc(e.message)+'</p>';}
}

// ---------------- public: live token list (Supabase Realtime) ----------------
// Amounts on public views are SOL with up to 4 decimals; tiny non-zero amounts show as "<0.0001".
const sv=n=>{if(n==null||n==='')return '—';const v=BigInt(String(n).split('.')[0]);if(v===0n)return '0';if(v<100000n)return '<0.0001';const s=String(v%1000000000n).padStart(9,'0').slice(0,4).replace(/0+$/,'');return String(v/1000000000n)+(s?'.'+s:'');};
const ago=t=>{const d=Math.max(0,Math.floor((Date.now()-new Date(t).getTime())/1000));return d<60?d+'s ago':d<3600?Math.floor(d/60)+'m ago':d<86400?Math.floor(d/3600)+'h ago':Math.floor(d/86400)+'d ago';};
const mmss=s=>s<=0?'now':Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
const wal=a=>'<a class="text-link live-address" href="https://solscan.io/account/'+esc(a)+'" target="_blank" rel="noopener noreferrer" title="'+esc(a)+'">'+esc(short(a))+'</a>';
let listChannel=null,feedChannel=null,tokenChannel=null;
const debounce=(fn,ms)=>{let t=null;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};};
async function realtime(name,tables,cb){await config();if(!supabase)return null;let ch=supabase.channel(name);for(const t of tables)ch=ch.on('postgres_changes',{event:t.event||'*',schema:'rebound',table:t.table,...(t.filter?{filter:t.filter}:{})},p=>cb(t.table,p));return ch.subscribe();}
function tile(t){
 // Homepage tiles show who got paid — no history progress, no round details (those live on the token page).
 const stats='<div class="tile-stats"><span><b>'+sv(t.paid_lamports)+'</b> SOL paid</span><span><b>'+esc(t.paid_recipients||0)+'</b> holders paid</span><span><b>'+esc(t.payouts||0)+'</b> payouts</span></div>';
 return '<a class="token-tile'+(t.featured?' featured':'')+'" href="#token/'+esc(t.mint)+'">'+(t.image_uri?'<img src="'+esc(t.image_uri)+'" alt="" loading="lazy">':'<span class="token-tile-ph"></span>')+'<span class="tile-body"><span class="tile-name"><b>'+esc(t.name||short(t.mint))+'</b> <small>'+esc(t.symbol||'')+'</small>'+(t.featured?' <i class="tag">REBOUND</i>':t.pinned?' <i class="tag neutral">REBOUND</i>':'')+(t.test?' <i class="tag neutral">TEST</i>':'')+'</span>'+
  '<small class="tile-sub">'+(t.featured?'REBOUND token':'Launched on REBOUND')+(t.market_cap_usd_pico?' · Mcap '+usdPico(t.market_cap_usd_pico):'')+'</small>'+stats+'</span></a>';
}
async function mountTokenList(host,signal){
 let view=sessionStorage.getItem('rebound-view')==='test'?'test':'production';
 const draw=async()=>{try{const r=await api('tokens',{query:{view},signal});if(!host.isConnected)return;
  host.innerHTML='<div class="section-heading"><h2>REBOUND tokens <span class="live-dot" title="Updates live"></span></h2><div class="token-view"><button class="btn small '+(view==='production'?'':'outline')+'" data-view="production">Live</button><button class="btn small '+(view==='test'?'':'outline')+'" data-view="test">Test launches</button></div></div>'+
   (r.tokens.length?'<div class="token-grid">'+r.tokens.map(tile).join('')+'</div>':'<p>No verified '+(view==='test'?'test ':'')+'launches yet.</p>');
  host.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;sessionStorage.setItem('rebound-view',view);draw();});
 }catch(e){if(host.isConnected&&!signal?.aborted)host.innerHTML='<h2>REBOUND tokens</h2><p>'+esc(e.message)+'</p>';}};
 await draw();
 if(!listChannel)try{listChannel=await realtime('public-tokens',[{table:'reward_public_tokens'},{table:'reward_site',event:'UPDATE'}],debounce(()=>{const h=document.querySelector('#token-list');if(h)mountTokenList(h);},800));}catch{}
}
// Homepage: live payout feed across all REBOUND tokens.
// withToken (homepage): who got paid, how much, when, proof. The token page also shows the loss and round.
function payoutRow(p,fresh,withToken){return '<tr'+(fresh?' class="fresh"':'')+'><td>'+esc(ago(p.paid_at))+'</td>'+(withToken?'<td><a href="#token/'+esc(p.mint)+'">'+esc(p.symbol||short(p.mint))+'</a></td>':'')+'<td>'+wal(p.owner)+'</td>'+(withToken?'':'<td class="num">'+sv(p.loss_lamports)+'</td>')+'<td class="num"><b>+'+sv(p.amount_lamports)+'</b></td>'+(withToken?'':'<td>'+esc(p.cycle_number)+'</td>')+'<td>'+tx(p.signature,'tx')+'</td></tr>';}
function payoutTable(list,withToken){return list.length?'<div class="table-container"><table class="token-table live-table"><thead><tr><th>When</th>'+(withToken?'<th>Token</th>':'')+'<th>Holder</th>'+(withToken?'':'<th class="num">Loss at snapshot, SOL</th>')+'<th class="num">Received, SOL</th>'+(withToken?'':'<th>Round</th>')+'<th>Proof</th></tr></thead><tbody>'+list.map(p=>payoutRow(p,false,withToken)).join('')+'</tbody></table></div>':'<p class="live-caption">No payouts yet. Every payment appears here the moment it lands on chain.</p>';}
async function mountPayoutFeed(host,signal){
 const draw=async()=>{try{const r=await api('payouts',{signal});if(host.isConnected)host.innerHTML='<div class="section-heading"><h2>Who got paid <span class="live-dot"></span></h2></div>'+payoutTable(r.payouts,true);}catch(e){if(host.isConnected&&!signal?.aborted)host.innerHTML='<h2>Who got paid</h2><p>'+esc(e.message)+'</p>';}};
 await draw();
 if(!feedChannel)try{feedChannel=await realtime('public-payouts',[{table:'reward_public_payouts',event:'INSERT'}],debounce(()=>{const h=document.querySelector('#payout-feed');if(h)mountPayoutFeed(h);},500));}catch{}
}

// ---------------- public: token rewards — rounds, holders, payouts (live) ----------------
// Data freshness: how far the stored positions trail the chain, and whether the indexer is running.
const LAG_WARN_SECONDS=300,INDEXER_STALE_MS=120000;
function freshness(t){
 const head=Number(t.head_time||0),pos=Number(t.positions_time||0),seen=t.indexer_at?Date.now()-new Date(t.indexer_at).getTime():null;
 if(seen!=null&&seen>INDEXER_STALE_MS)return{level:'warn',text:'Data paused: the indexer has not run for '+ago(t.indexer_at).replace(' ago','')+'. Figures below are as of '+(pos?new Date(pos*1000).toLocaleTimeString():'—')+'; rounds wait instead of paying on stale data.'};
 if(!pos)return head?{level:'info',text:'Verifying this token’s history — holder figures appear once it is complete.'}:null;
 const lag=Math.max(0,head-pos);
 if(lag>LAG_WARN_SECONDS)return{level:'warn',text:'Data is '+Math.round(lag/60)+' min behind the chain (verified through '+new Date(pos*1000).toLocaleTimeString()+'). Rounds wait until history is verified through their snapshot — nothing is paid on incomplete history.'};
 return{level:'ok',text:'Verified through '+new Date(pos*1000).toLocaleTimeString()+(head?' · '+lag+' s behind the chain':'')};
}
const freshHtml=t=>{const f=freshness(t);return f?'<p class="data-fresh '+f.level+'">'+esc(f.text)+'</p>':'';};
const ROUND_STATE={scheduled:'Scheduled',snapshotting:'Snapshot',waiting_for_data:'Waiting for data',funded:'Reserved — paying at round end',paying:'Paying',partially_paid:'Partly paid',complete:'Paid',dry_run:'Dry run (nothing sent)',skipped_no_funds:'No funds left',skipped_no_eligible_holders:'Nobody underwater',missed:'Missed'};
async function mountToken(host,mint,signal){
 let sort='loss',filter='current',offset=0,state=null,timer=null;
 const holdersHtml=h=>h.holders.length?'<div class="table-container"><table class="token-table live-table"><thead><tr><th>#</th><th>Holder</th><th class="num">Paid in, SOL</th><th class="num">Worth now, SOL</th><th class="num">Loss now, SOL</th><th class="num">Received, SOL</th><th class="num">Payouts</th><th>Status</th></tr></thead><tbody>'+
  h.holders.map((x,i)=>{const lossPct=BigInt(x.cost_lamports)>0n?Number(BigInt(x.loss_lamports)*1000n/BigInt(x.cost_lamports))/10:0;
   return '<tr><td>'+(h.offset+i+1)+'</td><td>'+wal(x.owner)+'</td><td class="num">'+sv(x.cost_lamports)+'</td><td class="num">'+sv(x.value_lamports)+'</td><td class="num'+(BigInt(x.loss_lamports)>0n?' neg':'')+'">'+(BigInt(x.loss_lamports)>0n?'−'+sv(x.loss_lamports)+' <small>('+lossPct+'%)</small>':'0')+'</td><td class="num'+(BigInt(x.paid_lamports)>0n?' pos':'')+'">'+(BigInt(x.paid_lamports)>0n?'+'+sv(x.paid_lamports):'0')+'</td><td class="num">'+esc(x.payouts)+'</td><td><small>'+esc({eligible:'underwater',no_remaining_loss:'even or up',sold:'sold',no_recognized_quantity:'no purchase record',exited:'sold or transferred — excluded',maturing:'counts 15 min after purchase',price_unavailable:'no price yet'}[x.outcome]||x.outcome.replace(/^hold:/,'on hold: ').replaceAll('_',' '))+'</small></td></tr>';}).join('')+
  '</tbody></table></div>'+(h.total>h.offset+h.holders.length?'<button class="btn outline small" id="holders-more">Show more ('+(h.total-h.offset-h.holders.length)+')</button>':''):'<p class="live-caption">No holders recorded yet. The table fills as soon as the token’s verified history is applied.</p>';
 const roundsHtml=cs=>cs.length?'<div class="table-container"><table class="token-table live-table"><thead><tr><th>Round</th><th>Status</th><th>Snapshot</th><th class="num">Underwater</th><th class="num">Total loss, SOL</th><th class="num">Available, SOL</th><th class="num">Awarded, SOL</th><th class="num">Paid, SOL</th></tr></thead><tbody>'+
  cs.map(c=>'<tr><td>'+esc(c.cycle_number)+'</td><td><span class="round-state s-'+esc(c.state)+'">'+esc(ROUND_STATE[c.state]||c.state.replaceAll('_',' '))+'</span>'+(c.reason&&['waiting_for_data','missed','skipped_no_funds','dry_run'].includes(c.state)?'<br><small>'+esc(c.reason.replaceAll('_',' '))+'</small>':'')+'</td><td>'+esc(new Date(Number(c.cutoff_time)*1000).toLocaleTimeString())+'</td><td class="num">'+esc(c.holders_underwater??'—')+(c.holders_counted!=null?' <small>/ '+esc(c.holders_counted)+'</small>':'')+'</td><td class="num">'+sv(c.total_loss_lamports)+'</td><td class="num">'+sv(c.available_lamports)+'</td><td class="num">'+sv(c.total_lamports)+(c.recipients?' <small>· '+esc(c.recipients)+'</small>':'')+'</td><td class="num">'+(BigInt(c.paid_lamports||0)>0n?'<b>'+sv(c.paid_lamports)+'</b> <small>· '+esc(c.paid_recipients)+'</small>':'—')+'</td></tr>').join('')+'</tbody></table></div>':'<p class="live-caption">No rounds yet.</p>';
 const clock=()=>{const el=host.querySelector('#round-clock');if(!el||!state){clearInterval(timer);return;}const c=state.cycles[0];if(!c)return;const now=Math.floor(Date.now()/1000);
  const end=Number(c.scheduled_end),cut=Number(c.cutoff_time);el.textContent=now<cut?'Snapshot in '+mmss(cut-now)+' · payout in '+mmss(end-now):now<end?'Snapshot taken · payout in '+mmss(end-now):'Next round starting…';};
 const drawHolders=async()=>{const box=host.querySelector('#holders-box');if(!box)return;try{const h=await api('token-holders',{query:{mint,sort,filter:filter==='current'?'':filter,offset:0,limit:offset+100}});box.innerHTML=holdersHtml(h);
   const more=box.querySelector('#holders-more');if(more)more.onclick=()=>{offset+=100;drawHolders();};}catch(e){box.innerHTML='<p>'+esc(e.message)+'</p>';}};
 const draw=async()=>{try{
  const r=await api('token',{query:{mint},signal});if(!host.isConnected)return;state=r;const t=r.token,st=r.stats,live=r.cycles[0]?.mode!=='dry_run';
  host.innerHTML='<div class="section-heading"><h2>'+(t.image_uri&&/^https:\/\//.test(t.image_uri)?'<img class="token-inline-img" src="'+esc(t.image_uri)+'" alt="">':'')+'Loss compensation · '+esc(t.symbol||t.name||short(mint))+' <span class="live-dot" title="Updates live"></span></h2><span class="tag '+(live?'':'neutral')+'">'+(live?'LIVE':'DRY RUN')+(t.test?' · TEST':'')+'</span></div>'+
   '<p class="live-caption" id="round-clock"></p>'+freshHtml(t)+
   (t.history_complete===false&&t.history_total?'<div class="history-progress"><div><span>Loading this token’s trade history before the first round: <b>'+esc(t.history_fetched||0)+'</b> of <b>'+esc(t.history_total)+'</b> transactions</span></div><progress max="'+esc(t.history_total)+'" value="'+esc(t.history_fetched||0)+'"></progress><small>Rounds start once every current holder’s purchases are known.</small></div>':'')+
   '<div class="live-metrics comp-metrics"><div><span>Paid to holders</span><strong>'+sv(t.paid_lamports)+' SOL</strong></div><div><span>Holders paid</span><strong>'+esc(t.paid_recipients||0)+'</strong><small>'+esc(t.payouts||0)+' payouts</small></div><div><span>Underwater now</span><strong>'+esc(st.underwater)+'</strong><small>of '+esc(st.holders)+' holders</small></div><div><span>Total loss now</span><strong>'+sv(st.loss)+' SOL</strong></div></div>'+
   '<p class="live-caption">Loss = SOL paid for the tokens still held − what they are worth now − compensation already received. A purchase counts after 15 minutes of holding; a wallet that sells or transfers the token is excluded for good. Holder figures update as verified trades arrive and are revalued at the latest price. Every '+(t.test?'2':'30')+' minutes a snapshot at the cutoff fixes who is underwater; the round’s funds are split in proportion to each loss and paid at the end of the round. Every payment links to its transaction.</p>'+
   '<h3>Latest payouts</h3><div id="payouts-box">'+payoutTable(r.payouts,false)+'</div>'+
   '<div class="section-heading"><h3>Holders</h3><div class="token-view" id="holder-tabs">'+[['loss','current','Biggest loss'],['paid','paid','Received'],['loss','all','Everyone']].map(([s2,f,l])=>'<button class="btn small '+(sort===s2&&filter===f?'':'outline')+'" data-sort="'+s2+'" data-filter="'+f+'">'+l+'</button>').join('')+'</div></div><div id="holders-box"><p>Loading…</p></div>'+
   '<h3>Rounds</h3>'+roundsHtml(r.cycles);
  host.querySelectorAll('#holder-tabs [data-sort]').forEach(b=>b.onclick=()=>{sort=b.dataset.sort;filter=b.dataset.filter;offset=0;host.querySelectorAll('#holder-tabs .btn').forEach(x=>x.classList.toggle('outline',x!==b));drawHolders();});
  await drawHolders();clearInterval(timer);timer=setInterval(clock,1000);clock();
 }catch(e){if(host.isConnected)host.innerHTML=e.status===404?'<p>This token is not a REBOUND token. Market data above is informational only.</p>':'<p>'+esc(e.message)+'</p>';}};
 await draw();
 try{tokenChannel?.unsubscribe();const f='mint=eq.'+mint;const redraw=debounce(()=>{if(host.isConnected)draw();else tokenChannel?.unsubscribe();},700);
  tokenChannel=await realtime('token-'+mint,[{table:'reward_public_cycles',filter:f},{table:'reward_public_tokens',filter:f,event:'UPDATE'},{table:'reward_public_payouts',filter:f,event:'INSERT'}],(table,p)=>{
   if(table==='reward_public_payouts'&&host.isConnected){const tb=host.querySelector('#payouts-box tbody');if(tb){tb.insertAdjacentHTML('afterbegin',payoutRow(p.new,true));}}redraw();});}catch{}
}

// ---------------- public: a wallet's awards ----------------
async function mountWalletRewards(host,signal){
 if(!wallet?.address){host.innerHTML='';return;}
 try{const r=await api('wallet-rewards',{query:{wallet:wallet.address},signal});if(!host.isConnected)return;
  host.innerHTML='<h2>Your REBOUND awards</h2>'+(r.awards.length?'<div class="table-container"><table class="token-table"><thead><tr><th>Token</th><th>Round</th><th>Award</th><th>Status</th><th>Due</th><th>Evidence</th></tr></thead><tbody>'+r.awards.map(a=>'<tr><td><a href="#token/'+esc(a.mint)+'">'+esc(short(a.mint))+'</a></td><td>'+esc(a.cycle_number)+'</td><td>'+sol(a.amount_lamports)+'</td><td>'+esc({planned:'Planned',reserved:'Reserved — paid at round end',paid:'Paid',deferred_rent:'Owed — waiting for account rent',released:'Cancelled (round not funded)'}[a.state]||a.state)+'</td><td>'+when(Number(a.scheduled_end))+'</td><td>'+tx(a.settlement_signature)+'</td></tr>').join('')+'</tbody></table></div>':'<p>No awards for this wallet yet. Awards are fixed at each round\'s snapshot for holders who are still underwater.</p>');
 }catch(e){if(host.isConnected)host.innerHTML='<h2>Your REBOUND awards</h2><p>'+esc(e.message)+'</p>';}
}

// ---------------- launch journey ----------------
let mintKey=null,launchBusy=false;
const attemptKey=()=>'rebound-launch-v3:'+(wallet?.address||'');
async function mountLaunch(host,toast,signal){
 await config().catch(()=>null);
 const enabled=!!cfg?.features?.launches;
 const saved=wallet?.address?localStorage.getItem(attemptKey()):null;
 host.innerHTML='<h2>Launch a token with REBOUND rewards</h2><p>Your wallet creates a regular Pump.fun coin. From its very first trade, all creator fees go to that coin\'s own REBOUND creator wallet — not to your wallet. Collected fees are split once: 85 % to underwater holders every 30 minutes, 15 % to buy and burn the REBOUND token. Holders who sell or transfer are excluded for good; a purchase counts after 15 minutes of holding.</p>'+
  (enabled?(cfg.launchNamespace==='mainnet_test'?'<p class="notice live-notice">Private mainnet test: only allowlisted wallets can launch; launches are labelled TEST.</p>':''):'<p class="notice live-notice">Launches are not open yet. They open after the reward program is deployed and verified.</p>')+
  (saved?'<p><button class="btn outline" id="launch-resume">Resume my launch</button></p>':'')+
  '<form id="launch-form"><label>Token name<input name="name" required maxlength="32" autocomplete="off"></label><label>Ticker<input name="symbol" required maxlength="10" pattern="[A-Za-z0-9$._-]+" autocomplete="off"></label><label>Description<textarea name="description" maxlength="2000"></textarea></label><label>Image (PNG or JPEG, under 2 MB)<input name="image" type="file" accept="image/png,image/jpeg" required></label><label>Website (optional)<input name="website" type="url" placeholder="https://"></label><label>X / Twitter (optional)<input name="twitter" type="url" placeholder="https://x.com/…"></label><label>Telegram (optional)<input name="telegram" type="url" placeholder="https://t.me/…"></label><label>Pair<select name="quote" id="launch-quote"><option value="">SOL</option></select><small class="field-hint">Like pump.fun: SOL, or an asset pump.fun admits (tokenized stocks, wrapped BTC/ETH…). Other tokens cannot be paired.</small></label><label>Initial buy in SOL (optional, SOL pair only)<input name="buy" inputmode="decimal" value="0"></label><button class="btn" '+(enabled?'':'disabled')+'>Review launch</button></form><div id="launch-flow" role="status" aria-live="polite"></div>';
 const flow=host.querySelector('#launch-flow');
 host.querySelector('#launch-resume')?.addEventListener('click',()=>run(()=>follow(flow,saved,toast)));
 host.querySelector('#launch-form').onsubmit=e=>{e.preventDefault();run(()=>start(flow,new FormData(e.target),toast));};
 // Pair assets come from pump.fun's own on-chain list; nothing else can be selected.
 if(enabled)api('launch-quotes',{signal}).then(r=>{const sel=host.querySelector('#launch-quote');if(!sel)return;
  sel.innerHTML=r.quotes.map(q=>'<option value="'+(q.sol?'':esc(q.mint))+'">'+esc(q.symbol||short(q.mint))+(q.name&&!q.sol?' · '+esc(q.name):'')+'</option>').join('');}).catch(()=>{});
 async function run(fn){if(launchBusy)return;launchBusy=true;try{await fn();}catch(err){flow.innerHTML='<p class="notice live-notice">'+esc(err.message)+'</p>';toast(err.message);}finally{launchBusy=false;}}
}
async function start(flow,form,toast){
 if(!wallet?.address)throw Error('Connect your wallet first.');
 const file=form.get('image');if(!file||file.size>2000000)throw Error('Choose a PNG or JPEG image smaller than 2 MB.');
 const initialBuyLamports=lamportsOf(form.get('buy'));
 flow.innerHTML='<p>Step 1 of 4 · Sign in and approve the token details (a message signature — no transaction, no SOL moves).</p>';
 const payload={name:String(form.get('name')).trim(),symbol:String(form.get('symbol')).trim(),description:String(form.get('description')||''),imageBase64:b64(new Uint8Array(await file.arrayBuffer())),website:form.get('website')||'',twitter:form.get('twitter')||'',telegram:form.get('telegram')||''};
 const proof=await consent('metadata-upload',payload);
 const meta=await api('metadata-upload',{body:{wallet:wallet.address,payload,proof},auth:true});
 const idem=crypto.randomUUID();
 const quoteMint=String(form.get('quote')||'')||null;if(quoteMint&&initialBuyLamports>0n)throw Error('An initial buy is available for SOL pairs only — buy on pump.fun after creation.');
 const d=await api('launch-draft',{body:{wallet:wallet.address,idempotencyKey:idem,metadataHash:meta.hash,name:payload.name,symbol:payload.symbol,initialBuyLamports:String(initialBuyLamports),namespace:cfg.launchNamespace,quoteMint},auth:true});
 localStorage.setItem(attemptKey(),d.attemptId);
 await review(flow,d.attemptId,toast);
}
async function review(flow,attemptId,toast){
 mintKey=Keypair.generate();   // ephemeral, stays in this tab; never sent to the server
 const p=await api('launch-prepare',{body:{attemptId,mint:mintKey.publicKey.toBase58()},auth:true});const x=p.disclosure;
 flow.innerHTML='<h3>Step 2 of 4 · Review</h3><div class="live-metrics"><div><span>Creator wallet</span><strong>'+esc(short(x.creatorWallet))+'</strong></div><div><span>'+(p.settlement==='direct'?'Fee wallet (REBOUND creator wallet)':'Commission treasury (program)')+'</span><strong>'+esc(short(x.commissionTreasury))+'</strong></div>'+(x.pair?'<div><span>Pair</span><strong>'+esc(x.pair.symbol||short(x.pair.mint))+'</strong></div>':'')+'<div><span>Initial buy</span><strong>'+sol(x.costs.initialBuyLamports)+'</strong></div><div><span>Burn target</span><strong>'+esc(short(x.primaryBurnTarget))+'</strong></div></div>'+
  '<p>'+esc(x.feeRouting)+'</p>'+(x.pairNote?'<p class="notice live-notice">'+esc(x.pairNote)+'</p>':'')+'<p>Rounds every '+(x.policy.cycleSeconds/60)+' minutes; snapshot '+x.policy.cutoffLeadSeconds+' s before each round ends; losses in '+esc(x.policy.lossUnit)+'. Policy '+esc(x.policy.version)+'.</p><p>'+(p.settlement==='direct'?'Holders who sell or transfer are excluded for good; a purchase counts after '+Math.round((x.policy.maturitySeconds||0)/60)+' minutes of holding. Costs you pay: Pump creation and account rent (about 0.011 SOL), '+sol(x.costs.operatingLamports)+' for the creator wallet\'s own network fees (fee collection, payouts, burns), network fees and your initial buy.':'Costs you pay: Pump creation and account rent (about 0.011 SOL), REBOUND coin account '+sol(x.costs.reboundCoinRentLamports)+', network fees, your initial buy, and later about 0.0094 SOL of fee-setup rent.')+' Irreversible: '+esc(x.irreversible.join(' '))+'</p><p>Mint: <span class="live-address">'+esc(p.mint)+'</span></p><button class="btn" id="launch-sign">Create token ('+p.transactions.length+' wallet approval'+(p.transactions.length>1?'s':'')+')</button>';
 flow.querySelector('#launch-sign').onclick=async()=>{try{
  flow.querySelector('#launch-sign').disabled=true;
  const s=await api('launch-submit',{body:{attemptId,index:0,signedTransaction:await signB64(p.transactions[0],[mintKey])},auth:true});
  flow.innerHTML=txSteps(2,s.signature,'Waiting for finality (usually under a minute)…');
  const st=await waitFor(attemptId,a=>a.state!=='creation_submitted');
  if(st.state!=='draft')flow.innerHTML=txSteps(3,s.signature,'');
  if(st.state==='draft'){flow.innerHTML='<p class="notice live-notice">The creation did not land; no token exists. Review again to retry with a fresh mint.</p><button class="btn" id="launch-again">Review again</button>';flow.querySelector('#launch-again').onclick=()=>review(flow,attemptId,toast).catch(e=>toast(e.message));return;}
  if(p.transactions[1]){flow.innerHTML='<p>Token created. Approve your initial buy.</p>';await api('launch-submit',{body:{attemptId,index:1,signedTransaction:await signB64(p.transactions[1])},auth:true});}
  if(p.settlement==='direct'){const a=await waitFor(attemptId,x=>x.state==='active'||x.state==='failed_action_required',120000);mintKey=null;return directDone(flow,a);}
  mintKey=null;await activation(flow,attemptId,toast);
 }catch(e){flow.querySelector('#launch-sign')&&(flow.querySelector('#launch-sign').disabled=false);toast(e.message);}};
}
// Transaction lifecycle (Motion kit): Signed → Sent → Finalized, driven only by real states.
function txSteps(reached,sig,note){const L=['Signed','Sent','Finalized'];
 return '<div class="tx-steps" data-reached="'+reached+'"><div class="tx-track">'+L.map((l,i)=>(i?'<span class="tx-seg'+(i<reached?' on':'')+'"></span>':'')+'<span class="tx-dot'+(i<reached?' on':'')+'"></span>').join('')+'</div>'+
  '<div class="tx-label mono">'+(reached>=3?'<span class="mint">Finalized · '+tx(sig,'tx')+'</span>':reached===2?'Sent · '+tx(sig,'tx')+' · waiting for finality':'Signed · sending…')+'</div>'+(note?'<p class="live-caption">'+esc(note)+'</p>':'')+'</div>';}
async function waitFor(attemptId,done,ms=180000){const until=Date.now()+ms;let st;while(Date.now()<until){st=await api('launch-status',{query:{id:attemptId},auth:true});if(done(st))return st;await sleep(4000);}return st;}
async function activation(flow,attemptId,toast){
 const st=await api('launch-status',{query:{id:attemptId},auth:true});
 if(st.state==='active'){localStorage.removeItem(attemptKey());flow.innerHTML='<p><b>Rewards active.</b> Fee routing is verified on chain. <a href="#token/'+esc(st.mint)+'">Open your token →</a></p>';return;}
 const a=await api('activation-prepare',{body:{attemptId},auth:true});
 if(!a.steps.length){const s=await waitFor(attemptId,x=>x.state==='active',120000);return activation(flow,attemptId,toast);}
 flow.innerHTML='<h3>Step 3 of 4 · Connect fees to the treasury</h3><p>Your token exists on Pump.fun; rewards stay inactive until these steps are verified. '+esc(a.note)+'</p><ol class="launch-steps">'+a.steps.map((s,i)=>'<li>'+esc({create_fee_sharing:'Create the fee-sharing account (pays ~0.0094 SOL rent to the treasury)',lock_fee_sharing:'Lock the treasury as the only fee recipient',activate:'Activate rewards'}[s.name]||s.name)+' <button class="btn small" data-step="'+i+'">Approve</button></li>').join('')+'</ol>';
 flow.querySelectorAll('[data-step]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const s=a.steps[Number(b.dataset.step)];
  const r=await api('activation-submit',{body:{attemptId,step:s.name,signedTransaction:await signB64(s.transaction)},auth:true});
  b.outerHTML='<span>Submitted '+tx(r.signature)+'</span>';await sleep(15000);await activation(flow,attemptId,toast);}catch(e){b.disabled=false;toast(e.message);}});
}
async function follow(flow,attemptId,toast){
 const st=await api('launch-status',{query:{id:attemptId},auth:true});
 if(['draft','awaiting_creation_signature'].includes(st.state))return review(flow,attemptId,toast);
 if(st.state==='creation_submitted'){flow.innerHTML='<p>Waiting for the creation to finalize…</p>';await waitFor(attemptId,a=>a.state!=='creation_submitted');return follow(flow,attemptId,toast);}
 if(st.settlement==='direct')return directDone(flow,st);
 return activation(flow,attemptId,toast);
}
// Launch without the program: nothing to activate; the token is live once registered.
function directDone(flow,a){
 if(a.state==='active'){localStorage.removeItem(attemptKey());
  flow.innerHTML=a.rewards==='pair_pending'
   ?'<p><b>Token live.</b> Rounds for pairs other than SOL start once REBOUND enables pair-asset accounting; until then its creator fees stay in its pump.fun creator vault and nothing is lost. <a href="#token/'+esc(a.mint)+'">Open your token →</a></p>'
   :'<p><b>Token live, rewards active.</b> Its creator fees go to its REBOUND creator wallet: 85 % to underwater holders, 15 % buys and burns the REBOUND token. <a href="#token/'+esc(a.mint)+'">Open your token →</a></p>';return;}
 if(a.state==='failed_action_required'){flow.innerHTML='<p class="notice live-notice">The token was created but its creator could not be verified; rewards stay off. Contact the team.</p>';return;}
 flow.innerHTML='<p>Waiting for the token to be registered… Reopen this page in a minute.</p>';
}

// ---------------- administrator dashboard ----------------
let logsChannel=null;
async function mountAdmin(host,toast){
 if(!adminToken()){
  let viaWallet=false;if(wallet?.address)try{viaWallet=(await whoami()).admin;}catch{}
  if(!viaWallet)return adminLogin(host,toast);
 }
 let o;try{o=await api('admin-overview',{auth:true});}catch(e){if(adminToken()&&(e.status===401||e.status===403)){setAdminToken(null);return adminLogin(host,toast,'Your admin session ended. Sign in again.');}host.innerHTML='<p>'+esc(e.message)+'</p>';return;}
 const plat=Object.fromEntries(o.platform.map(p=>[p.namespace,p])),t=plat.mainnet_test||{};
 const rows=(list,cols)=>list.length?'<div class="table-container"><table class="token-table"><thead><tr>'+cols.map(c=>'<th>'+esc(c[0])+'</th>').join('')+'</tr></thead><tbody>'+list.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':'<p>None yet.</p>';
 const st=o.site||{},tok=o.siteToken,ns=st.namespace||'production',pl=plat[ns]||{},coin=o.coins.find(c=>c.mint===st.primary_mint);
 const wk=o.health.find(h=>h.component==='worker'),wkOk=wk&&wk.status==='ok'&&Date.now()-new Date(wk.heartbeat_at).getTime()<120000;
 const step=(ok,title,note)=>'<li class="'+(ok?'ok':'')+'"><i>'+(ok?'✓':'·')+'</i><div>'+title+(note?'<small>'+note+'</small>':'')+'</div></li>';
 const fwLive=o.fundingWallets.find(w=>w.mint===st.primary_mint&&w.status!=='retired'),sc=o.siteChain,budgetModel=fwLive?.funding_model==='balance_budget';
 const used=fwLive?.budget_set_at&&sc?.coin?BigInt(sc.coin.deposits)-BigInt(fwLive.budget_start_deposits||0):0n,left=fwLive?.budget_lamports!=null?BigInt(fwLive.budget_lamports)-(used>0n?used:0n):null;
 const fundingNote=!fwLive?'':budgetModel?(fwLive.budget_set_at&&(!fwLive.budget_requested_at||new Date(fwLive.budget_set_at)>=new Date(fwLive.budget_requested_at))?'Budget '+sol(fwLive.budget_lamports)+' ('+(fwLive.budget_bps/100)+' % of '+sol(fwLive.budget_balance_lamports)+') · paid into rounds '+sol(used>0n?used:0n)+' · left '+sol(left>0n?left:0n):'Budget '+(fwLive.budget_bps/100)+' % of the balance — the worker measures the balance on its next pass.'):'85 % of every new SOL that arrives in the fee wallet from now on.';
 const chainBtn=sc?.next?'<button class="btn small" id="adm-chain-next" data-action="'+esc(sc.next)+'">Sign with the admin wallet: '+esc({registerPrimary:'register the token on chain',startPrimary:'start the rounds',setFundingWallet:'set this fee wallet on chain'}[sc.next])+'</button>':'';
 const direct=(pl.settlement||'direct')==='direct',budgetReady=!!(fwLive?.budget_set_at&&(!fwLive.budget_requested_at||new Date(fwLive.budget_set_at)>=new Date(fwLive.budget_requested_at)));
 const launchHtml='<section class="card live-card adm-launch"><h2>Launch</h2><p>Choose the token, the fee wallet that funds holders, and how much of it may be paid out. Every round the worker finds the holders who are underwater (in SOL: what they paid versus what their tokens are worth at the snapshot) and pays them in proportion to their loss, never more than the loss. You can change the token or the wallet at any time — the site, the token card and the chart follow immediately.</p>'+
  '<div class="adm-current"><div><span>Token contract</span><b>'+(st.primary_mint?esc(st.primary_mint):'not set')+'</b>'+(st.primary_name?'<small>'+esc(st.primary_name)+(st.primary_symbol?' · '+esc(st.primary_symbol):'')+'</small>':'')+'</div><div><span>Fee wallet</span><b>'+(st.fee_wallet?esc(st.fee_wallet):'not set')+'</b>'+(fwLive?'<small>'+esc(fwLive.mode==='automatic'?'automatic deposits (key on the worker)':'manual deposits (key not imported)')+'</small>':'')+'</div><div><span>Mode</span><b>'+esc(ns==='production'?'production (30-minute rounds)':'private test (2-minute rounds)')+' · '+esc(pl.execution_mode||'dry_run')+'</b>'+(fundingNote?'<small>'+esc(fundingNote)+'</small>':'')+'</div></div>'+
  '<form id="adm-launch" class="adm-form"><label>Token contract address (mint)<input name="mint" required autocomplete="off" spellcheck="false" value="'+esc(st.primary_mint||'')+'"></label><label>Fee wallet address (public address; the key is added below)<input name="feeWallet" required autocomplete="off" spellcheck="false" value="'+esc(st.fee_wallet||'')+'"></label>'+
  '<label>Namespace<select name="namespace"><option value="mainnet_test"'+(ns==='mainnet_test'?' selected':'')+'>Private test (2-minute rounds, spending caps)</option><option value="production"'+(ns==='production'?' selected':'')+'>Production (30-minute rounds)</option></select></label>'+
  '<label>Funding<select name="fundingModel"><option value="balance_budget"'+(fwLive?.funding_model!=='income'?' selected':'')+'>Budget: a share of the wallet’s current balance</option>'+'<option value="income"'+(fwLive?.funding_model==='income'?' selected':'')+'>85 % of new creator fees (15 % stays on the dev wallet)</option></select></label>'+
  '<label>Budget, % of the current balance<input name="budgetPercent" type="number" min="0.01" max="100" step="0.01" value="'+esc(fwLive?.budget_bps?fwLive.budget_bps/100:50)+'"></label>'+
  (budgetModel&&fwLive?.budget_requested_at?'<label class="adm-check"><input type="checkbox" name="newBudget" value="1"> Fix a new budget from the current balance (starts the count of what was paid from zero)</label>':'')+
  '<label class="adm-check"><input type="checkbox" name="startTest" value="1"'+(ns==='mainnet_test'&&pl.execution_mode==='mainnet_test'?' checked':'')+'> Private test: start real payouts now (mainnet_test mode, any holder of this token, caps from the budget)</label>'+
  '<div><button class="btn">Save and launch</button></div></form><p class="live-caption">The budget is fixed once from the balance at the first launch and is the most this wallet pays out in total; saving again keeps it (you can lower the percentage any time). Each round deposits only what it pays, and 0.01 SOL always stays in the wallet.</p>'+
  '<ol class="adm-steps">'+step(!!(st.primary_mint&&st.fee_wallet),'Token and fee wallet saved')+
  step(tok?.exists===true,'Token exists on Solana mainnet',tok?.exists===false?'No mint at this address yet.':tok?.exists==null&&st.primary_mint?'Could not check right now.':'')+
  (direct?step(coin?.status==='active','Rounds started',coin?'Paid straight from the fee wallet (no on-chain program). Status: '+esc(coin.status):''):
  step(!!o.chain?.initialized,'Rewards program deployed',o.chain?'':'Program id is not configured on this host yet (see the mainnet runbook).')+
  step(coin?.status==='active'&&!sc?.next,'Token registered and started on chain',(sc?.coin?'On chain: '+(sc.coin.active?'started':'registered, not started')+(sc.coin.fundingWallet!==st.fee_wallet?' · fee wallet on chain '+esc(short(sc.coin.fundingWallet)):''):sc?.deployment?'Not registered on chain yet.':'')+(coin?' · database: '+esc(coin.status)+(coin.blocked_reason?' — '+esc(coin.blocked_reason):''):'')+
  (chainBtn?'<br>'+chainBtn:'')))+
  step(fwLive?.mode==='automatic','Fee wallet key on the worker','Needed so every round is paid automatically — add it below.')+
  step(budgetReady,'Budget measured',budgetReady?'':'The worker measures the fee wallet balance on its next pass.')+
  step(!!wkOk,'Worker online','Indexes trades, takes snapshots, pays rounds.')+
  step(pl.execution_mode&&pl.execution_mode!=='dry_run','Payouts live',pl.execution_mode==='dry_run'||!pl.execution_mode?'Dry run: rounds are calculated, nothing is signed or sent.':'')+
  '</ol></section>';
 const inbox=(o.keyInbox||[]).filter(k=>!fwLive||k.funding_wallet===fwLive.id).slice(0,3);
 const keyHtml='<section class="card live-card adm-launch"><h2>Fee wallet key (automatic deposits)</h2><p>Paste the fee wallet’s private key to let the worker move the holders’ share every round without asking you. It is encrypted in this browser to the worker’s own key before it is sent; this site and its database only ever store ciphertext they cannot read. The worker checks that it belongs to '+(st.fee_wallet?'<b>'+esc(short(st.fee_wallet))+'</b>':'the fee wallet')+', stores it encrypted on the worker host, and the pasted copy is wiped. Use a wallet that holds only what you are willing to commit.</p>'+
  (o.workerKey?'':'<p class="notice live-notice">The worker has not published its key yet — start the worker first, then reload.</p>')+
  '<form id="adm-key" class="adm-form"><label>Private key (base58 from Phantom → Export private key, or a [..] array)<textarea name="secret" rows="2" autocomplete="off" spellcheck="false" autocapitalize="off" style="-webkit-text-security:disc"></textarea></label><div><button class="btn"'+(o.workerKey&&fwLive?'':' disabled')+'>Encrypt and send to the worker</button></div></form>'+
  (inbox.length?'<ul class="adm-inbox">'+inbox.map(k=>'<li>'+when(k.created_at)+' · '+esc(short(k.address))+' · <b>'+esc({pending:'waiting for the worker',imported:'imported ✓',failed:'rejected'}[k.state]||k.state)+'</b>'+(k.reason?' — '+esc(k.reason):'')+'</li>').join('')+'</ul>':'')+
  (o.workerKey?'<p class="live-caption">Worker key <code class="live-address">'+esc(o.workerKey.inbox_public_key)+'</code> (updated '+when(o.workerKey.updated_at)+'). Before pasting, check that it equals the <b>key-inbox</b> line keygen printed on your worker machine.</p>':'')+'</section>';
 const siteHtml='<section class="card live-card"><h2>Site access</h2><div class="adm-switch"><strong>'+(st.site_open?'Open to everyone':'Password required (private preview)')+'</strong><form id="adm-site-open"><button class="btn '+(st.site_open?'outline':'')+'" name="open" value="'+(st.site_open?'false':'true')+'">'+(st.site_open?'Require the password again':'Open the site (remove password)')+'</button></form></div></section>'+
  '<section class="card live-card"><h2>Wallet connection (Privy)</h2><p>With a Privy App ID the site offers Privy’s Solana wallet picker (Phantom, Solflare, Backpack and others). Add https://rebound.wtf to the allowed origins in the Privy dashboard.</p><form id="adm-privy" class="adm-form"><label>Privy App ID<input name="appId" autocomplete="off" spellcheck="false" value="'+esc(st.privy_app_id||'')+'" placeholder="cl…"></label><div><button class="btn outline">Save</button></div></form></section>';
 const logsHtml='<section class="card live-card"><h2>Logs <small>(live)</small></h2><form id="adm-logs-filter" class="live-search"><div><input name="search" placeholder="Search messages"><select name="severity"><option value="">any severity</option><option>info</option><option>warn</option><option>error</option><option>critical</option></select><button class="btn outline">Filter</button></div></form><div id="adm-logs"></div></section>';
 const roundsAdm='<section class="card live-card"><h2>Rounds <small>(all tokens)</small></h2>'+rows(o.cycles,[['Token',r=>'<a href="#token/'+esc(r.mint)+'">'+esc(short(r.mint))+'</a>'],['#',r=>esc(r.cycle_number)],['State',r=>esc(r.state.replaceAll('_',' '))],['Why',r=>esc((r.reason||'').replaceAll('_',' '))],['Snapshot',r=>when(Number(r.cutoff_time))],['Available',r=>sol(r.holder_reserve_lamports)],['Total loss',r=>sol(r.total_loss_usd)],['Awarded',r=>sol(r.total_lamports)],['Holders',r=>esc(r.eligible_count??'—')]])+'</section>';
 const resultsHtml=st.primary_mint?'<section class="card live-card" id="adm-results"><p>Loading live results…</p></section>':'';
 host.innerHTML=launchHtml+keyHtml+resultsHtml+roundsAdm+siteHtml+logsHtml+'<section class="card live-card"><h2>Status</h2><div class="live-metrics">'+o.platform.map(p=>'<div><span>'+esc(p.namespace)+'</span><strong>'+esc(p.execution_mode)+(p.paused?' · paused':'')+'</strong><small>spent '+sol(p.spent_total_lamports)+' / cap '+sol(p.spend_cap_total_lamports)+'</small></div>').join('')+'<div><span>Host ceiling</span><strong>'+esc(o.hostCeiling)+'</strong><small>production '+(o.productionAllowed?'allowed':'locked')+'</small></div></div>'+
  rows(o.health,[['Component',r=>esc(r.component)],['Status',r=>esc(r.status)],['Heartbeat',r=>when(r.heartbeat_at)]])+'</section>'+
  '<details class="adm-advanced"><summary>Advanced</summary><section class="card live-card"><h2>Execution mode</h2><form id="adm-mode"><label>Namespace<select name="namespace"><option value="mainnet_test">mainnet_test (private test)</option><option value="production">production</option></select></label><label>Mode<select name="mode"><option>dry_run</option><option>mainnet_test</option><option>production</option></select></label><label>Reason<input name="reason" maxlength="200"></label><button class="btn">Approve with wallet</button></form>'+
  '<form id="adm-pause"><button class="btn outline" name="op" value="pause">Pause test namespace</button><button class="btn outline" name="op" value="resume">Resume test namespace</button></form></section>'+
  '<section class="card live-card"><h2>Private test configuration</h2><form id="adm-test"><label>Allowlisted mints (one per line)<textarea name="mints">'+esc((t.test_allowlist_mints||[]).join('\n'))+'</textarea></label><label>Allowlisted wallets (one per line)<textarea name="wallets">'+esc((t.test_allowlist_wallets||[]).join('\n'))+'</textarea></label><label>Per-action cap (SOL)<input name="a" value="'+esc(sol(t.spend_cap_action_lamports).replace(' SOL',''))+'"></label><label>Per-cycle cap (SOL)<input name="c" value="'+esc(sol(t.spend_cap_cycle_lamports).replace(' SOL',''))+'"></label><label>Total cap (SOL)<input name="t" value="'+esc(sol(t.spend_cap_total_lamports).replace(' SOL',''))+'"></label><label>Buyback max slippage (bps)<input name="s" value="'+esc(t.buyback_max_slippage_bps)+'"></label><label>Buyback max price impact (bps)<input name="i" value="'+esc(t.buyback_max_impact_bps)+'"></label><button class="btn">Approve with wallet</button></form></section>'+
  '<section class="card live-card"><h2>Program (on chain)</h2>'+(o.chain?(o.chain.error?'<p>'+esc(o.chain.error)+'</p>':'<p>Program '+acct(o.chain.program)+' · deployment '+(o.chain.initialized?'initialized':'<b>not initialized</b>')+'</p>'+(o.chain.state?'<p class="live-caption">admin '+esc(short(o.chain.state.admin))+' · publisher '+esc(short(o.chain.state.publisher))+' · verifier '+esc(short(o.chain.state.verifier))+' · test mode '+o.chain.state.testMode+' · paused '+o.chain.state.paused+' · buyback target '+esc(short(o.chain.state.targetMint))+' (v'+esc(o.chain.state.configVersion)+')</p>':'')):'<p>REWARDS_PROGRAM_ID is not configured on this host.</p>')+
  '<form id="adm-chain"><label>Action<select name="action"><option value="initialize">initialize</option><option value="setBuybackTarget">setBuybackTarget</option><option value="registerPrimary">registerPrimary</option><option value="startPrimary">startPrimary</option><option value="setFundingWallet">setFundingWallet</option><option value="pause">pause</option><option value="requestResume">requestResume</option><option value="resume">resume</option></select></label><label>Parameters (JSON)<textarea name="params" placeholder=\'{"publisher":"…","verifier":"…","guardian":"…","testMode":true}\'></textarea></label><button class="btn">Prepare, sign with admin wallet, submit</button></form><p class="live-caption">The server simulates first and verifies your signed bytes before broadcasting. Your wallet must be the program\'s upgrade authority.</p></section>'+
  '<section class="card live-card"><h2>REBOUND token (primary)</h2><form id="adm-primary"><label>Namespace<select name="namespace"><option value="mainnet_test">mainnet_test</option><option value="production">production</option></select></label><label>Primary mint<input name="mint" value="'+esc(t.primary_mint||'')+'"></label><label>Dev funding wallet (you must be signed in with it)<input name="fundingWallet"></label><button class="btn">Register (manual funding)</button></form>'+
  '<form id="adm-opening"><label>Primary mint<input name="mint" value="'+esc(t.primary_mint||'')+'"></label><label>Opening credit from the current dev-wallet balance (SOL)<input name="credit" value="0"></label><label>Operational reserve kept on the dev wallet (SOL)<input name="reserve" value="0"></label><button class="btn outline">Request opening credit</button></form>'+
  '<div id="adm-funding"><button class="btn" id="adm-plan">Show the holder deposit waiting for the dev wallet</button></div>'+
  rows(o.fundingWallets,[['Mint',r=>esc(short(r.mint))],['Dev wallet',r=>acct(r.address)],['Mode',r=>esc(r.mode)],['Status',r=>esc(r.status)],['Opening',r=>r.opening_slot?sol(r.opening_credit_lamports)+' @'+esc(r.opening_slot):'—']])+
  rows(o.fundingAccounts,[['Mint',r=>esc(short(r.mint))],['Credited',r=>sol(r.credited)],['Holders awaiting deposit',r=>sol(r.holder_awaiting_transfer)],['Holders available',r=>sol(r.holder_available)],['15 % retained/reserve',r=>sol(r.other_settled)+' / '+sol(r.other_available)]])+'</section>'+
  '<section class="card live-card"><h2>Coins</h2>'+rows(o.coins,[['Mint',r=>'<a href="#token/'+esc(r.mint)+'">'+esc(short(r.mint))+'</a>'],['Kind',r=>esc(r.kind)],['Ns',r=>esc(r.namespace)],['Status',r=>esc(r.status)+(r.blocked_reason?' ('+esc(r.blocked_reason)+')':'')],['Name',r=>esc(r.symbol||'')]])+'</section>'+
  '<section class="card live-card"><h2>Creator-fee receipts</h2>'+rows(o.receipts,[['Mint',r=>esc(short(r.mint))],['Amount',r=>sol(r.amount_lamports)],['State',r=>esc(r.state)+(r.reason?' · '+esc(r.reason):'')],['85 / 15',r=>sol(r.holder_lamports)+' / '+sol(r.buyback_lamports)],['Collection',r=>tx(r.signature,'tx')]])+'</section>'+
  '<section class="card live-card"><h2>Buyback & burn</h2>'+rows(o.buybackJobs,[['From',r=>esc(short(r.source_mint))],['Budget',r=>sol(r.budget_lamports)],['State',r=>esc(r.state)+(r.reason?' · '+esc(r.reason):'')],['Spent',r=>sol(r.spent_lamports)],['Burned (raw)',r=>esc(r.burned_raw||'—')],['Evidence',r=>tx(r.purchase_signature,'buy')+' '+tx(r.burn_signature,'burn')]])+'</section>'+
  '</details>'+adminAccountHtml(o);
 if(st.primary_mint&&host.querySelector('#adm-results'))mountToken(host.querySelector('#adm-results'),st.primary_mint);
 const sub=(id,fn)=>{const f=host.querySelector(id);if(f)f.onsubmit=async e=>{e.preventDefault();const b=e.submitter;if(b)b.disabled=true;try{const r=await fn(new FormData(f),e.submitter);toast('Done');if(r!==false)mountAdmin(host,toast);}catch(err){toast(err.message);}finally{if(b)b.disabled=false;}};};
 sub('#adm-mode',f=>adminCall('admin-set-mode',{namespace:f.get('namespace'),mode:f.get('mode'),reason:f.get('reason')}));
 sub('#adm-pause',(f,b)=>adminCall(b?.value==='resume'?'admin-resume':'admin-pause',{namespace:'mainnet_test',reason:'admin dashboard'}));
 const lines=v=>String(v||'').split(/\s+/).map(s=>s.trim()).filter(Boolean);
 sub('#adm-test',f=>adminCall('admin-test-config',{namespace:'mainnet_test',mints:lines(f.get('mints')),wallets:lines(f.get('wallets')),capAction:String(lamportsOf(f.get('a'))),capCycle:String(lamportsOf(f.get('c'))),capTotal:String(lamportsOf(f.get('t'))),slippageBps:Number(f.get('s')),impactBps:Number(f.get('i'))}));
 sub('#adm-primary',f=>adminCall('admin-register-primary',{namespace:f.get('namespace'),mint:String(f.get('mint')).trim(),fundingWallet:String(f.get('fundingWallet')).trim()},{mint:String(f.get('mint')).trim(),fundingMode:'manual'}));
 sub('#adm-opening',f=>adminCall('admin-opening-credit',{mint:String(f.get('mint')).trim(),requestedCreditLamports:String(lamportsOf(f.get('credit'))),operationalReserveLamports:String(lamportsOf(f.get('reserve')))},{mint:String(f.get('mint')).trim()}));
 sub('#adm-set-wallet',f=>adminCall('admin-set-wallet',{wallet:String(f.get('wallet')).trim(),label:'owner'}));
 sub('#adm-password',async f=>{if(f.get('next')!==f.get('confirm'))throw Error('The new passwords do not match.');const r=await api('admin-password',{body:{current:f.get('current'),next:f.get('next')}});setAdminToken(r.token);});
 const out=host.querySelector('#adm-signout');if(out)out.onclick=()=>{setAdminToken(null);adminLogin(host,toast,'Signed out.');};
 sub('#adm-launch',async f=>{const r=await adminCall('admin-launch',{mint:String(f.get('mint')).trim(),feeWallet:String(f.get('feeWallet')).trim(),namespace:f.get('namespace'),fundingModel:f.get('fundingModel'),budgetPercent:Number(f.get('budgetPercent')||50),newBudget:f.get('newBudget')==='1',startTest:f.get('namespace')==='mainnet_test'&&f.get('startTest')==='1'});
  if(r.exists===false)toast('Saved. No token exists at this address on mainnet yet.');else if(r.budgetEstimate)toast('Saved. New budget ≈ '+sol(r.budgetEstimate)+' ('+(r.budgetBps/100)+' % of '+sol(r.balance)+').');else if(r.budgetAction==='kept')toast('Saved. The budget is unchanged.');else if(r.budgetAction==='lowered')toast('Saved. Budget lowered to '+(r.budgetBps/100)+' %.');});
 const keyForm=host.querySelector('#adm-key');if(keyForm)keyForm.onsubmit=async e=>{e.preventDefault();const btn=e.submitter;if(btn)btn.disabled=true;const area=keyForm.elements.secret;let bytes=null;
  try{if(!o.workerKey)throw Error('The worker has not published its key yet.');if(!fwLive)throw Error('Save and launch first.');
   bytes=parseSecretKey(area.value);area.value='';
   let kp;try{kp=Keypair.fromSecretKey(Uint8Array.from(bytes));}catch{throw Error('That is not a valid Solana private key.');}
   const addr=kp.publicKey.toBase58();try{kp._keypair.secretKey.fill(0);}catch{}if(addr!==fwLive.address)throw Error('This key belongs to '+short(addr)+', not to the fee wallet '+short(fwLive.address)+'.');
   const sealed=await Seal.seal(bytes,{fundingWallet:fwLive.id,address:fwLive.address,inboxPublicKey:o.workerKey.inbox_public_key});
   await adminCall('admin-key-submit',{mint:st.primary_mint,address:fwLive.address,inboxPublicKey:o.workerKey.inbox_public_key,...sealed},{mint:st.primary_mint});
   toast('Encrypted and sent. The worker imports it within a few seconds.');setTimeout(()=>mountAdmin(host,toast),6000);}
  catch(err){toast(err.message);}finally{if(bytes)bytes.fill(0);area.value='';if(btn)btn.disabled=false;}};
 const cn=host.querySelector('#adm-chain-next');if(cn)cn.onclick=async()=>{cn.disabled=true;try{if(!wallet?.address)throw Error('Connect the administrator wallet (the program’s upgrade authority) first.');
   const p=await api('admin-program-prepare',{body:{wallet:wallet.address,action:cn.dataset.action,params:{mint:st.primary_mint,fundingWallet:st.fee_wallet}},auth:true});
   const r=await api('admin-program-submit',{body:{intentId:p.intentId,signedTransaction:await signB64(p.transaction)},auth:true});toast('Submitted '+short(r.signature)+' — finalizes in about 15 s.');setTimeout(()=>mountAdmin(host,toast),16000);}
  catch(e){toast(e.message);cn.disabled=false;}};
 sub('#adm-site-open',(f,b)=>adminCall('admin-site',{open:b?.value==='true'}));
 sub('#adm-privy',f=>adminCall('admin-site',{privyAppId:String(f.get('appId')||'').trim()||null}));
 sub('#adm-chain',async f=>{let params={};const txt=String(f.get('params')||'').trim();if(txt)try{params=JSON.parse(txt);}catch{throw Error('Parameters must be JSON');}
  const p=await api('admin-program-prepare',{body:{wallet:wallet.address,action:f.get('action'),params},auth:true});
  const r=await api('admin-program-submit',{body:{intentId:p.intentId,signedTransaction:await signB64(p.transaction)},auth:true});toast('Submitted '+short(r.signature));});
 host.querySelector('#adm-plan').onclick=async()=>{const box=host.querySelector('#adm-funding');try{const mint=t.primary_mint;if(!mint)throw Error('Register the primary first');
  const r=await api('funding-plan',{query:{mint},auth:true});if(!r.plan){box.innerHTML='<p>No holder deposit is waiting for a signature.</p>';return;}const p=r.plan;
  box.innerHTML='<p>Round '+esc(p.cycle)+': deposit <b>'+sol(p.amountLamports)+'</b> from the dev wallet '+acct(p.signer)+' to the holder reserve (holder-only; never split). Expires '+when(p.expiresAt)+'.</p><button class="btn" id="adm-plan-sign">Sign with the dev wallet</button>';
  box.querySelector('#adm-plan-sign').onclick=async()=>{try{if(wallet.address!==p.signer)throw Error('Switch to the dev wallet '+short(p.signer)+' to sign.');const s=await api('funding-submit',{body:{mint,intentId:p.intentId,signedTransaction:await signB64(p.transaction)},auth:true});box.innerHTML='<p>Deposit '+esc(s.state)+'. '+tx(s.signature)+'</p>';}catch(e){toast(e.message);}};
 }catch(e){box.innerHTML='<p>'+esc(e.message)+'</p>';}};
 const logs=host.querySelector('#adm-logs');let filter={};
 const drawLogs=async()=>{try{const r=await api('admin-logs',{query:filter,auth:true});logs.innerHTML=logRows(r.logs);}catch(e){logs.innerHTML='<p>'+esc(e.message)+'</p>';}};
 host.querySelector('#adm-logs-filter').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);filter=Object.fromEntries([...f.entries()].filter(([,v])=>v));drawLogs();};
 await drawLogs();
 try{if(supabase){await supabase.realtime.setAuth(session?.access_token);logsChannel?.unsubscribe();logsChannel=supabase.channel('admin-logs').on('postgres_changes',{event:'INSERT',schema:'rebound',table:'reward_logs'},p=>{const l=document.querySelector('#adm-logs table tbody');if(l&&!filter.search&&!filter.severity)l.insertAdjacentHTML('afterbegin',logRows([p.new],true));}).subscribe();}}catch{}
}
function adminAccountHtml(o){
 const active=o.admins.filter(a=>!a.revoked_at);
 return '<section class="card live-card adm-launch"><h2>Administrator wallet</h2><p>This wallet can also open the dashboard by signing in, and it signs on-chain program actions (it must be the program’s upgrade authority for those). Setting a new wallet replaces the old one.</p>'+
  '<div class="adm-current"><div><span>Current admin wallet</span><b>'+(active.length?active.map(a=>esc(a.wallet)).join('<br>'):'not set')+'</b></div></div>'+
  '<form id="adm-set-wallet" class="adm-form"><label>Admin wallet address<input name="wallet" required autocomplete="off" spellcheck="false"></label><div><button class="btn">Set admin wallet</button></div></form></section>'+
  '<section class="card live-card"><h2>Dashboard password</h2>'+(o.access?.via==='password'?'<p class="live-caption">Signed in with the password'+(o.access.expiresAt?' · session until '+when(o.access.expiresAt):'')+'.</p>':'')+
  '<form id="adm-password" class="adm-form"><label>Current password<input name="current" type="password" autocomplete="current-password" required></label><label>New password (at least 10 characters)<input name="next" type="password" autocomplete="new-password" minlength="10" required></label><label>Repeat the new password<input name="confirm" type="password" autocomplete="new-password" minlength="10" required></label><div><button class="btn outline">Change password</button> '+(o.access?.via==='password'?'<button type="button" class="btn outline" id="adm-signout">Sign out</button>':'')+'</div></form><p class="live-caption">Changing the password signs out every other session.</p></section>';
}
async function adminLogin(host,toast,message){
 let st;try{st=await api('admin-auth-state');}catch(e){host.innerHTML='<p>'+esc(e.message)+'</p>';return;}
 const note=message?'<p class="live-caption">'+esc(message)+'</p>':'';
 if(st.passwordSet){
  host.innerHTML='<section class="card live-card adm-launch"><h2>Administrator sign-in</h2>'+note+'<form id="adm-login" class="adm-form"><label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label><div><button class="btn">Sign in</button></div></form><p class="live-caption">Or connect the administrator wallet and reload this page.</p></section>';
  host.querySelector('#adm-login').onsubmit=async e=>{e.preventDefault();const b=e.submitter;if(b)b.disabled=true;try{const r=await api('admin-login',{body:{password:new FormData(e.target).get('password')}});setAdminToken(r.token);mountAdmin(host,toast);}catch(err){toast(err.message);}finally{if(b)b.disabled=false;}};
 }else if(st.setupOpen){
  host.innerHTML='<section class="card live-card adm-launch"><h2>Create the administrator password</h2>'+note+'<p>Enter the one-time setup code you were given, then choose the dashboard password.</p><form id="adm-setup" class="adm-form"><label>Setup code<input name="code" required autocomplete="off" spellcheck="false"></label><label>New password (at least 10 characters)<input name="password" type="password" autocomplete="new-password" minlength="10" required></label><label>Repeat the password<input name="confirm" type="password" autocomplete="new-password" minlength="10" required></label><div><button class="btn">Create password</button></div></form></section>';
  host.querySelector('#adm-setup').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),b=e.submitter;if(f.get('password')!==f.get('confirm')){toast('The passwords do not match.');return;}if(b)b.disabled=true;try{const r=await api('admin-setup',{body:{code:String(f.get('code')).trim(),password:f.get('password')}});setAdminToken(r.token);toast('Password created');mountAdmin(host,toast);}catch(err){toast(err.message);}finally{if(b)b.disabled=false;}};
 }else host.innerHTML='<section class="card live-card"><h2>Administration</h2>'+note+'<p>The dashboard password has not been set up yet. Ask the operator for a one-time setup code.</p></section>';
}
function logRows(list,rowsOnly){const r=list.map(l=>'<tr class="sev-'+esc(l.severity)+'"><td>'+when(l.timestamp_utc)+'</td><td>'+esc(l.severity)+'</td><td>'+esc(l.component)+'</td><td>'+esc(l.event_type)+'</td><td>'+esc(l.mint?short(l.mint):'')+'</td><td>'+esc(l.safe_message)+(l.error_code?' <code>'+esc(l.error_code)+'</code>':'')+'</td></tr>').join('');
 return rowsOnly?r:'<div class="table-container"><table class="token-table"><thead><tr><th>Time</th><th>Severity</th><th>Component</th><th>Event</th><th>Mint</th><th>Message</th></tr></thead><tbody>'+r+'</tbody></table></div>';}

// The token's own image (from its metadata, resolved by the indexer) replaces the placeholder logo.
async function tokenImage(img,signal){try{const r=await api('token',{query:{mint:img.dataset.tokenImage},signal});const u=r.token?.image_uri;if(u&&/^https:\/\//.test(u)&&img.isConnected){img.src=u;img.alt=r.token.symbol||r.token.name||'';}}catch{}}
// Read-only chain endpoint (balances at finalized commitment) for the wallet check.
async function readChain(action,address,signal){
 const r=await fetch('/.netlify/functions/chain?'+new URLSearchParams({action,address}),{signal,cache:'no-store'});
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error('chain data unavailable on this host');
 const j=await r.json();if(!r.ok)throw Error(j.message||'chain data unavailable');return j;}
// ---------------- mount by route ----------------
async function mount({route,mint,toast,signal}){
 const q=s=>document.querySelector(s);
 if(q('#rewards-summary'))mountSummary(q('#rewards-summary'),signal);
 if(route==='explore'&&q('#home'))mountHome(q('#home'),{api,realtime,esc,signal,primary:mint});
 if(route==='check'&&q('#check'))mountCheck(q('#check'),{api,esc,signal,connected:!!wallet?.address,isAddress:a=>window.ReboundData.isAddress(a),chain:readChain});
 if(route==='explore'&&q('#token-list'))mountTokenList(q('#token-list'),signal);
 if(route==='explore'&&q('#payout-feed'))mountPayoutFeed(q('#payout-feed'),signal);
 for(const img of document.querySelectorAll('img[data-token-image]'))tokenImage(img,signal);
 if(route==='launch'&&q('#rewards-launch'))mountLaunch(q('#rewards-launch'),toast,signal);
 if(route==='portfolio'&&q('#wallet-rewards'))mountWalletRewards(q('#wallet-rewards'),signal);
 if(route==='token'&&q('#token-rewards'))mountToken(q('#token-rewards'),mint,signal);
 if(route==='admin'&&q('#admin-root'))mountAdmin(q('#admin-root'),toast);
}
async function isAdmin(){try{if(adminToken())return true;if(!wallet?.address)return false;await config();if(!supabase)return false;const s=(await supabase.auth.getSession()).data.session;if(!s||!verifiedAddresses(s.user).includes(wallet.address))return false;session=s;return (await whoami()).admin;}catch{return false;}}
// Site settings (REBOUND token, name) follow the admin dashboard in real time; a slow poll covers
// dropped Realtime connections.
let siteChannel=null;
async function onSite(cb){
 await config();const map=r=>({open:!!r.site_open,primaryMint:r.primary_mint||null,name:r.primary_name||null,symbol:r.primary_symbol||null});
 try{if(supabase){siteChannel?.unsubscribe();siteChannel=supabase.channel('site-settings').on('postgres_changes',{event:'UPDATE',schema:'rebound',table:'reward_site'},p=>cb(map(p.new))).subscribe();}}catch{}
 setInterval(async()=>{try{const c=await api('config');cb(c.siteSettings);}catch{}},60000);
}
window.ReboundV3={initWallet,mount,config,isAdmin,onSite,signIn:()=>accessToken().then(()=>whoami())};
