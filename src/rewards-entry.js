/* REBOUND V3 browser bundle: wallet (Privy when configured), Supabase session, launch journey,
   live token list, wallet rewards, token cycles and the administrator dashboard.
   Browsers never supply amounts, eligibility, roles or instructions: every transaction shown for
   signing was built and is re-verified by the server; a sign-in or consent signature can never
   move SOL or tokens. */
import {createClient} from '@supabase/supabase-js';
import {Keypair,Transaction} from '@solana/web3.js';
import {signInWithSelectedWallet,verifiedAddresses,onWalletChanged} from './auth/wallet-session.js';

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

let cfg=null,supabase=null,session=null,me=null,cfgPromise=null;
async function api(action,{query={},body,auth=false,signal}={}){
 const headers={};if(body)headers['content-type']='application/json';
 if(auth){const t=await accessToken();headers.authorization='Bearer '+t;}
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
async function adminCall(action,payload,binding){const proof=await consent(action,payload,binding);return api(action,{body:{wallet:wallet.address,payload,proof},auth:true});}
async function signB64(b64tx,extraSigners=[]){const t=Transaction.from(raw(b64tx));if(extraSigners.length)t.partialSign(...extraSigners);const signed=await wallet.signTransaction(t);return b64(signed.serialize({requireAllSignatures:true,verifySignatures:true}));}

// ---------------- public: policy/health summary ----------------
const POLICY='<p><b>Where the money comes from.</b> Only creator fees that were actually collected, and — for the REBOUND token — SOL the dev wallet really received. Trading volume is not a reward balance.</p><p><b>85 / 15, once.</b> 85 % goes to holders who are still underwater; the split happens once when funding arrives. For launched tokens the other 15 % buys the REBOUND token on its canonical market and <b>burns</b> it. For the REBOUND token itself the 15 % stays with its dev wallet.</p><p><b>Loss in USD.</b> Remaining loss = cost of the tokens you still hold − their value now − compensation already paid or reserved. Value uses the higher of spot and a 60-second average; SOL/USD is converted with Pyth. A move in SOL/USD can change a loss even when the token price did not.</p><p><b>Every 30 minutes.</b> A snapshot 60 seconds before each round fixes every award. Awards are paid at the end of the round and stay payable even if you sell afterwards. No returns are guaranteed.</p>';
async function mountSummary(host,signal){
 try{const h=await api('health',{signal});await config();if(!host.isConnected)return;
  const ns=(cfg.namespaces||[]).map(n=>'<span class="tag neutral">'+esc(n.namespace==='mainnet_test'?'Private test':'Production')+': '+esc(n.executionMode.replace('_',' '))+(n.paused?' · paused':'')+'</span>').join(' ');
  host.innerHTML='<h2>How REBOUND rewards work</h2>'+POLICY+'<p>'+ns+'</p><p class="live-caption">Service: '+esc(h.state.replaceAll('_',' '))+(h.worker?' · worker heartbeat '+when(h.worker.heartbeatAt):'')+' · policy '+esc(h.policy?.version||'')+'</p>';
 }catch(e){if(!signal?.aborted&&host.isConnected)host.innerHTML='<h2>How REBOUND rewards work</h2>'+POLICY+'<p>'+esc(e.message)+'</p>';}
}

// ---------------- public: live token list (Supabase Realtime) ----------------
let listChannel=null;
async function mountTokenList(host,signal){
 let view=sessionStorage.getItem('rebound-view')==='test'?'test':'production';
 const draw=async()=>{try{const r=await api('tokens',{query:{view},signal});if(!host.isConnected)return;
  host.innerHTML='<div class="section-heading"><h2>REBOUND tokens</h2><div class="token-view"><button class="btn small '+(view==='production'?'':'outline')+'" data-view="production">Live</button><button class="btn small '+(view==='test'?'':'outline')+'" data-view="test">Test launches</button></div></div>'+
   (r.tokens.length?'<div class="token-grid">'+r.tokens.map(t=>'<a class="token-tile" href="#token/'+esc(t.mint)+'">'+(t.image_uri?'<img src="'+esc(t.image_uri)+'" alt="" loading="lazy">':'<span class="token-tile-ph"></span>')+'<span><b>'+esc(t.name||short(t.mint))+'</b> <small>'+esc(t.symbol||'')+'</small>'+(t.pinned?' <i class="tag neutral">REBOUND</i>':'')+(t.test?' <i class="tag neutral">TEST</i>':'')+'<br><small>Mcap '+usdPico(t.market_cap_usd_pico)+' · '+esc(t.reward_status)+'</small></span></a>').join('')+'</div>':'<p>No verified '+(view==='test'?'test ':'')+'launches yet. Tokens appear here once their fee routing is verified on chain.</p>');
  host.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;sessionStorage.setItem('rebound-view',view);draw();});
 }catch(e){if(host.isConnected&&!signal?.aborted)host.innerHTML='<h2>REBOUND tokens</h2><p>'+esc(e.message)+'</p>';}};
 await draw();
 try{await config();if(supabase&&!listChannel){let t=null;listChannel=supabase.channel('public-tokens').on('postgres_changes',{event:'*',schema:'rebound',table:'reward_public_tokens'},()=>{clearTimeout(t);t=setTimeout(()=>{const h=document.querySelector('#token-list');if(h)mountTokenList(h);},800);}).subscribe();}}catch{}
}

// ---------------- public: token rewards + cycles ----------------
async function mountToken(host,mint,signal){
 try{const r=await api('token',{query:{mint},signal});if(!host.isConnected)return;const t=r.token;
  host.innerHTML='<div class="section-heading"><h2>REBOUND rewards · '+esc(t.symbol||short(mint))+'</h2><span class="tag neutral">'+esc(t.reward_status)+(t.test?' · TEST':'')+'</span></div><div class="live-metrics"><div><span>Paid to holders</span><strong>'+sol(t.paid_lamports)+'</strong></div><div><span>REBOUND burned (raw)</span><strong>'+esc(t.burned_primary_raw)+'</strong></div><div><span>Pending buyback</span><strong>'+sol(t.pending_buyback_lamports)+'</strong></div><div><span>Market cap</span><strong>'+usdPico(t.market_cap_usd_pico)+'</strong></div></div><p class="live-caption">'+esc(t.supply_definition||'')+(t.price_source?' · '+esc(t.price_source):'')+'</p>'+
   (r.cycles.length?'<div class="table-container"><table class="token-table"><thead><tr><th>Round</th><th>State</th><th>Snapshot</th><th>Paid at</th><th>Total</th><th>Recipients</th></tr></thead><tbody>'+r.cycles.map(c=>'<tr><td>'+esc(c.cycle_number)+'</td><td>'+esc(c.state.replaceAll('_',' '))+'</td><td>'+when(Number(c.cutoff_time))+'</td><td>'+when(Number(c.scheduled_end))+'</td><td>'+sol(c.total_lamports)+'</td><td>'+esc(c.recipients??'—')+'</td></tr>').join('')+'</tbody></table></div>':'<p>No rounds yet.</p>');
 }catch(e){if(host.isConnected)host.innerHTML=e.status===404?'<p>This token is not a verified REBOUND launch. Market data above is informational only.</p>':'<p>'+esc(e.message)+'</p>';}
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
 host.innerHTML='<h2>Launch a token with REBOUND rewards</h2><p>Your wallet creates a regular Pump.fun coin. From its very first trade, all creator fees go to that coin\'s own program-controlled treasury — not to your wallet. Collected fees are split once: 85 % to underwater holders every 30 minutes, 15 % to buy and burn the REBOUND token.</p>'+
  (enabled?(cfg.launchNamespace==='mainnet_test'?'<p class="notice live-notice">Private mainnet test: only allowlisted wallets can launch; launches are labelled TEST.</p>':''):'<p class="notice live-notice">Launches are not open yet. They open after the reward program is deployed and verified.</p>')+
  (saved?'<p><button class="btn outline" id="launch-resume">Resume my launch</button></p>':'')+
  '<form id="launch-form"><label>Token name<input name="name" required maxlength="32" autocomplete="off"></label><label>Ticker<input name="symbol" required maxlength="10" pattern="[A-Za-z0-9$._-]+" autocomplete="off"></label><label>Description<textarea name="description" maxlength="2000"></textarea></label><label>Image (PNG or JPEG, under 2 MB)<input name="image" type="file" accept="image/png,image/jpeg" required></label><label>Website (optional)<input name="website" type="url" placeholder="https://"></label><label>X / Twitter (optional)<input name="twitter" type="url" placeholder="https://x.com/…"></label><label>Telegram (optional)<input name="telegram" type="url" placeholder="https://t.me/…"></label><label>Initial buy in SOL (optional)<input name="buy" inputmode="decimal" value="0"></label><button class="btn" '+(enabled?'':'disabled')+'>Review launch</button></form><div id="launch-flow" role="status" aria-live="polite"></div>';
 const flow=host.querySelector('#launch-flow');
 host.querySelector('#launch-resume')?.addEventListener('click',()=>run(()=>follow(flow,saved,toast)));
 host.querySelector('#launch-form').onsubmit=e=>{e.preventDefault();run(()=>start(flow,new FormData(e.target),toast));};
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
 const d=await api('launch-draft',{body:{wallet:wallet.address,idempotencyKey:idem,metadataHash:meta.hash,name:payload.name,symbol:payload.symbol,initialBuyLamports:String(initialBuyLamports),namespace:cfg.launchNamespace},auth:true});
 localStorage.setItem(attemptKey(),d.attemptId);
 await review(flow,d.attemptId,toast);
}
async function review(flow,attemptId,toast){
 mintKey=Keypair.generate();   // ephemeral, stays in this tab; never sent to the server
 const p=await api('launch-prepare',{body:{attemptId,mint:mintKey.publicKey.toBase58()},auth:true});const x=p.disclosure;
 flow.innerHTML='<h3>Step 2 of 4 · Review</h3><div class="live-metrics"><div><span>Creator wallet</span><strong>'+esc(short(x.creatorWallet))+'</strong></div><div><span>Commission treasury (program)</span><strong>'+esc(short(x.commissionTreasury))+'</strong></div><div><span>Initial buy</span><strong>'+sol(x.costs.initialBuyLamports)+'</strong></div><div><span>Burn target</span><strong>'+esc(short(x.primaryBurnTarget))+'</strong></div></div>'+
  '<p>'+esc(x.feeRouting)+'</p><p>Rounds every '+(x.policy.cycleSeconds/60)+' minutes; snapshot '+x.policy.cutoffLeadSeconds+' s before each round ends; losses in '+esc(x.policy.lossUnit)+'. Policy '+esc(x.policy.version)+'.</p><p>Costs you pay: Pump creation and account rent (about 0.011 SOL), REBOUND coin account '+sol(x.costs.reboundCoinRentLamports)+', network fees, your initial buy, and later about 0.0094 SOL of fee-setup rent. Irreversible: '+esc(x.irreversible.join(' '))+'</p><p>Mint: <span class="live-address">'+esc(p.mint)+'</span></p><button class="btn" id="launch-sign">Create token ('+p.transactions.length+' wallet approval'+(p.transactions.length>1?'s':'')+')</button>';
 flow.querySelector('#launch-sign').onclick=async()=>{try{
  flow.querySelector('#launch-sign').disabled=true;
  const s=await api('launch-submit',{body:{attemptId,index:0,signedTransaction:await signB64(p.transactions[0],[mintKey])},auth:true});
  flow.innerHTML='<p>Creation submitted. '+tx(s.signature)+' Waiting for finality (usually under a minute)…</p>';
  const st=await waitFor(attemptId,a=>a.state!=='creation_submitted');
  if(st.state==='draft'){flow.innerHTML='<p class="notice live-notice">The creation did not land; no token exists. Review again to retry with a fresh mint.</p><button class="btn" id="launch-again">Review again</button>';flow.querySelector('#launch-again').onclick=()=>review(flow,attemptId,toast).catch(e=>toast(e.message));return;}
  if(p.transactions[1]){flow.innerHTML='<p>Token created. Approve your initial buy.</p>';await api('launch-submit',{body:{attemptId,index:1,signedTransaction:await signB64(p.transactions[1])},auth:true});}
  mintKey=null;await activation(flow,attemptId,toast);
 }catch(e){flow.querySelector('#launch-sign')&&(flow.querySelector('#launch-sign').disabled=false);toast(e.message);}};
}
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
 return activation(flow,attemptId,toast);
}

// ---------------- administrator dashboard ----------------
let logsChannel=null;
async function mountAdmin(host,toast){
 if(!wallet?.address){host.innerHTML='<p>Connect your administrator wallet.</p>';return;}
 let who;try{who=await whoami();}catch(e){host.innerHTML='<p>'+esc(e.message)+'</p>';return;}
 if(!who.admin){host.innerHTML='<p>This wallet is not a REBOUND administrator.</p>';return;}
 let o;try{o=await api('admin-overview',{auth:true});}catch(e){host.innerHTML='<p>'+esc(e.message)+'</p>';return;}
 const plat=Object.fromEntries(o.platform.map(p=>[p.namespace,p])),t=plat.mainnet_test||{};
 const rows=(list,cols)=>list.length?'<div class="table-container"><table class="token-table"><thead><tr>'+cols.map(c=>'<th>'+esc(c[0])+'</th>').join('')+'</tr></thead><tbody>'+list.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':'<p>None yet.</p>';
 host.innerHTML='<section class="card live-card"><h2>Status</h2><div class="live-metrics">'+o.platform.map(p=>'<div><span>'+esc(p.namespace)+'</span><strong>'+esc(p.execution_mode)+(p.paused?' · paused':'')+'</strong><small>spent '+sol(p.spent_total_lamports)+' / cap '+sol(p.spend_cap_total_lamports)+'</small></div>').join('')+'<div><span>Host ceiling</span><strong>'+esc(o.hostCeiling)+'</strong><small>production '+(o.productionAllowed?'allowed':'locked')+'</small></div></div>'+
  rows(o.health,[['Component',r=>esc(r.component)],['Status',r=>esc(r.status)],['Heartbeat',r=>when(r.heartbeat_at)]])+'</section>'+
  '<section class="card live-card"><h2>Execution mode</h2><form id="adm-mode"><label>Namespace<select name="namespace"><option value="mainnet_test">mainnet_test (private test)</option><option value="production">production</option></select></label><label>Mode<select name="mode"><option>dry_run</option><option>mainnet_test</option><option>production</option></select></label><label>Reason<input name="reason" maxlength="200"></label><button class="btn">Approve with wallet</button></form>'+
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
  '<section class="card live-card"><h2>Rounds</h2>'+rows(o.cycles,[['Mint',r=>esc(short(r.mint))],['#',r=>esc(r.cycle_number)],['State',r=>esc(r.state)+(r.reason?' · '+esc(r.reason):'')],['Snapshot',r=>when(Number(r.cutoff_time))],['Total',r=>sol(r.total_lamports)],['Holders',r=>esc(r.eligible_count??'—')]])+'</section>'+
  '<section class="card live-card"><h2>Creator-fee receipts</h2>'+rows(o.receipts,[['Mint',r=>esc(short(r.mint))],['Amount',r=>sol(r.amount_lamports)],['State',r=>esc(r.state)+(r.reason?' · '+esc(r.reason):'')],['85 / 15',r=>sol(r.holder_lamports)+' / '+sol(r.buyback_lamports)],['Collection',r=>tx(r.signature,'tx')]])+'</section>'+
  '<section class="card live-card"><h2>Buyback & burn</h2>'+rows(o.buybackJobs,[['From',r=>esc(short(r.source_mint))],['Budget',r=>sol(r.budget_lamports)],['State',r=>esc(r.state)+(r.reason?' · '+esc(r.reason):'')],['Spent',r=>sol(r.spent_lamports)],['Burned (raw)',r=>esc(r.burned_raw||'—')],['Evidence',r=>tx(r.purchase_signature,'buy')+' '+tx(r.burn_signature,'burn')]])+'</section>'+
  '<section class="card live-card"><h2>Administrators</h2>'+rows(o.admins,[['Wallet',r=>acct(r.wallet)],['Label',r=>esc(r.label)],['Added',r=>when(r.added_at)],['Revoked',r=>r.revoked_at?when(r.revoked_at):'—']])+'<form id="adm-add"><label>Add admin wallet<input name="wallet"></label><label>Label<input name="label" maxlength="60"></label><button class="btn outline">Approve with wallet</button></form></section>'+
  '<section class="card live-card"><h2>Logs <small>(live)</small></h2><form id="adm-logs-filter" class="live-search"><div><input name="search" placeholder="Search messages"><select name="severity"><option value="">any severity</option><option>info</option><option>warn</option><option>error</option><option>critical</option></select><button class="btn outline">Filter</button></div></form><div id="adm-logs"></div></section>';
 const sub=(id,fn)=>{const f=host.querySelector(id);if(f)f.onsubmit=async e=>{e.preventDefault();const b=e.submitter;if(b)b.disabled=true;try{const r=await fn(new FormData(f),e.submitter);toast('Done');if(r!==false)mountAdmin(host,toast);}catch(err){toast(err.message);}finally{if(b)b.disabled=false;}};};
 sub('#adm-mode',f=>adminCall('admin-set-mode',{namespace:f.get('namespace'),mode:f.get('mode'),reason:f.get('reason')}));
 sub('#adm-pause',(f,b)=>adminCall(b?.value==='resume'?'admin-resume':'admin-pause',{namespace:'mainnet_test',reason:'admin dashboard'}));
 const lines=v=>String(v||'').split(/\s+/).map(s=>s.trim()).filter(Boolean);
 sub('#adm-test',f=>adminCall('admin-test-config',{namespace:'mainnet_test',mints:lines(f.get('mints')),wallets:lines(f.get('wallets')),capAction:String(lamportsOf(f.get('a'))),capCycle:String(lamportsOf(f.get('c'))),capTotal:String(lamportsOf(f.get('t'))),slippageBps:Number(f.get('s')),impactBps:Number(f.get('i'))}));
 sub('#adm-primary',f=>adminCall('admin-register-primary',{namespace:f.get('namespace'),mint:String(f.get('mint')).trim(),fundingWallet:String(f.get('fundingWallet')).trim()},{mint:String(f.get('mint')).trim(),fundingMode:'manual'}));
 sub('#adm-opening',f=>adminCall('admin-opening-credit',{mint:String(f.get('mint')).trim(),requestedCreditLamports:String(lamportsOf(f.get('credit'))),operationalReserveLamports:String(lamportsOf(f.get('reserve')))},{mint:String(f.get('mint')).trim()}));
 sub('#adm-add',f=>adminCall('admin-add-admin',{wallet:String(f.get('wallet')).trim(),label:f.get('label')}));
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
function logRows(list,rowsOnly){const r=list.map(l=>'<tr class="sev-'+esc(l.severity)+'"><td>'+when(l.timestamp_utc)+'</td><td>'+esc(l.severity)+'</td><td>'+esc(l.component)+'</td><td>'+esc(l.event_type)+'</td><td>'+esc(l.mint?short(l.mint):'')+'</td><td>'+esc(l.safe_message)+(l.error_code?' <code>'+esc(l.error_code)+'</code>':'')+'</td></tr>').join('');
 return rowsOnly?r:'<div class="table-container"><table class="token-table"><thead><tr><th>Time</th><th>Severity</th><th>Component</th><th>Event</th><th>Mint</th><th>Message</th></tr></thead><tbody>'+r+'</tbody></table></div>';}

// ---------------- mount by route ----------------
async function mount({route,mint,toast,signal}){
 const q=s=>document.querySelector(s);
 if(q('#rewards-summary'))mountSummary(q('#rewards-summary'),signal);
 if(route==='explore'&&q('#token-list'))mountTokenList(q('#token-list'),signal);
 if(route==='launch'&&q('#rewards-launch'))mountLaunch(q('#rewards-launch'),toast,signal);
 if(route==='portfolio'&&q('#wallet-rewards'))mountWalletRewards(q('#wallet-rewards'),signal);
 if(route==='token'&&q('#token-rewards'))mountToken(q('#token-rewards'),mint,signal);
 if(route==='admin'&&q('#admin-root'))mountAdmin(q('#admin-root'),toast);
}
async function isAdmin(){try{if(!wallet?.address)return false;await config();if(!supabase)return false;const s=(await supabase.auth.getSession()).data.session;if(!s||!verifiedAddresses(s.user).includes(wallet.address))return false;session=s;return (await whoami()).admin;}catch{return false;}}
window.ReboundV3={initWallet,mount,config,isAdmin,signIn:()=>accessToken().then(()=>whoami())};
