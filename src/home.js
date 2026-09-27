/* Home and wallet check ("Proof in motion"). Read-only views over the existing public API:
   config, token, tokens, payouts, token-holders, wallet-rewards and the chain endpoint. Nothing here
   signs, submits or changes reward state. Every figure comes from those reads; when a read is empty
   or fails, the view says so instead of showing an example. */

const LAMPORTS=1000000000n;
const big=v=>{try{return BigInt(String(v??0).split('.')[0]);}catch{return 0n;}};
/** SOL with up to `d` decimals (trailing zeros trimmed); tiny non-zero amounts show as <0.001. */
export function solText(lamports,d=3){const v=big(lamports);if(v===0n)return '0';const neg=v<0n,a=neg?-v:v;
 const unit=10n**BigInt(9-d);if(a<unit)return (neg?'−':'')+'<'+(1/10**d).toFixed(d);
 const whole=a/LAMPORTS,frac=String((a%LAMPORTS)/unit).padStart(d,'0').replace(/0+$/,'');
 return (neg?'−':'')+whole.toLocaleString('en-US')+(frac?'.'+frac:'');}
const compact=n=>{const x=Number(n);if(!Number.isFinite(x))return '—';if(x<1000)return x.toLocaleString('en-US',{maximumFractionDigits:2});
 const u=[['T',1e12],['B',1e9],['M',1e6],['K',1e3]].find(([,v])=>x>=v);return (x/u[1]).toLocaleString('en-US',{maximumFractionDigits:2})+u[0];};
const usdPico=n=>{if(n==null)return null;const x=Number(big(n))/1e12;return x>0?'$'+compact(x):null;};
const mmss=s=>{s=Math.max(0,Math.floor(s));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const ago=t=>{const d=Math.max(0,Math.floor((Date.now()-new Date(t).getTime())/1000));return d<60?d+' s ago':d<3600?Math.floor(d/60)+' min ago':d<86400?Math.floor(d/3600)+' h ago':Math.floor(d/86400)+' d ago';};
const reduced=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MARK='<svg viewBox="0 0 34 34" aria-hidden="true"><g transform="translate(-1 1)"><path d="M7 9v9a9 9 0 0 0 18 0V6M19 11l6-6 5 6" fill="none" stroke="#E4F0E8" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round"/></g></svg>';
const CHECK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
export const ROUND_STATE={scheduled:'Scheduled',snapshotting:'Snapshot',waiting_for_data:'Waiting for data',funded:'Reserved — paying at round end',paying:'Paying',partially_paid:'Partly paid',complete:'Settled',dry_run:'Dry run — nothing sent',skipped_no_funds:'No funds this round',skipped_no_eligible_holders:'Nobody underwater',missed:'Missed'};
const REASON={paused:'paused',snapshot_window_closed:'snapshot window closed'};

/** Odometer count-up (Motion kit): each digit rolls into place once; plain text with reduced motion. */
export function odometer(el,text,armOnly=false){
 if(!el)return;el.setAttribute('aria-label',text);
 if(reduced()||el.dataset.rolled===text){el.textContent=text;return;}
 if(!armOnly&&el.dataset.armed===text){el.dataset.rolled=text;requestAnimationFrame(()=>el.classList.add('odo-go'));return;}
 if(armOnly)el.dataset.armed=text;else el.dataset.rolled=text;let k=0;
 el.innerHTML='<span class="odo" aria-hidden="true">'+[...text].map(c=>/\d/.test(c)?'<span class="odo-col" style="--d:'+c+';--i:'+(k++)+'"><span>'+'0123456789'.split('').map(x=>'<span>'+x+'</span>').join('')+'</span></span>':'<span class="odo-ch">'+c.replace('<','&lt;')+'</span>').join('')+'</span>';
 if(!armOnly)requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('odo-go')));
}

function makeToast(slot,html,ms=4000){
 if(!slot)return;slot.innerHTML='';const n=document.createElement('div');n.className='pay-toast';n.setAttribute('role','status');n.innerHTML=html+'<i class="pay-toast-bar" style="animation-duration:'+ms+'ms"></i>';
 slot.append(n);setTimeout(()=>{n.classList.add('out');setTimeout(()=>n.remove(),400);},ms);
}

// ---------------- home ----------------
let homeChannel=null,homeState=null;
export async function mountHome(host,{api,realtime,esc,signal,primary}){
 const st={host,esc,api,primary,cfg:null,token:null,tokens:null,payouts:null,skew:0,timer:null,refetch:0,burned:null};homeState=st;
 const q=s=>host.querySelector(s);
 const alive=()=>host.isConnected&&homeState===st&&!signal?.aborted;
 const tx=(sig,label,title)=>sig?'<a class="proof" href="https://solscan.io/tx/'+esc(sig)+'" target="_blank" rel="noopener noreferrer" data-proof="'+esc(title||('Opens Solscan · tx '+sig.slice(0,4)+'…'+sig.slice(-4)))+'">'+esc(label)+' ↗</a>':'';

 // Fixed texts that follow the published policy.
 const flow=()=>{const p=st.cfg?.policy||{},h=(p.holdersBps??8500)/100,o=(p.otherBps??1500)/100;
  const lede=q('#home-lede');if(lede)lede.textContent=h+'% of creator fees go to holders who are underwater. Every '+(p.cycleSeconds?Math.round(p.cycleSeconds/60)+' minutes':'round')+', in SOL.';
  const f=q('#flow-diagram');if(f)f.innerHTML=flowDiagram(h,o);
  const n=q('#flow-note');if(n)n.textContent='Each launched token has its own fee wallet held by the REBOUND worker. For the REBOUND token itself the '+o+'% stays with its dev wallet. Every payout and burn links to its transaction.';
  const w=q('.waterline-art');if(w&&!w.firstChild)w.innerHTML=WATERLINE_ART;};

 const load=async()=>{
  const [cfg,token,tokens,payouts]=await Promise.allSettled([api('config',{signal}),api('token',{query:{mint:primary},signal}),api('tokens',{signal}),api('payouts',{signal})]);
  if(!alive())return;
  st.cfg=cfg.value||null;st.token=token.status==='fulfilled'?token.value:{error:token.reason};st.tokens=tokens.value||null;st.payouts=payouts.value||null;
  if(st.token.now)st.skew=st.token.now-Math.floor(Date.now()/1000);
  flow();renderRound();renderVerify(tokens.status==='rejected'?tokens.reason:null);renderRounds();renderCoins(tokens.status==='rejected'?tokens.reason:null);
 };
 const now=()=>Math.floor(Date.now()/1000)+st.skew;

 function timing(){const cs=st.token?.cycles||[],c=cs[0];if(!c)return null;
  let len=Number(st.cfg?.policy?.cycleSeconds||1800);
  for(let i=1;i<cs.length;i++){const dn=cs[i-1].cycle_number-cs[i].cycle_number,de=Number(cs[i-1].scheduled_end)-Number(cs[i].scheduled_end);if(dn>0&&de>0){len=de/dn;break;}}
  const end=Number(c.scheduled_end),cut=Number(c.cutoff_time);return{c,len,end,cut,lead:Math.max(0,end-cut)};}

 function renderRound(){
  const box=q('#round-card');if(!box)return;const t=st.token;
  if(!t||t.error||!t.token){box.innerHTML='<div class="round-empty"><h3>No live round to show</h3><p>'+esc(t?.error?.status===404?'The REBOUND token is not registered for rewards yet.':'Round data is unavailable right now. Nothing is estimated in its place.')+'</p></div>';return;}
  const tm=timing(),tok=t.token,ns=(st.cfg?.namespaces||[]).find(n=>n.namespace===tok.namespace),paused=!!ns?.paused;
  const sym=(tok.symbol||tok.name||'REBOUND').trim(),p=st.cfg?.policy||{},h=(p.holdersBps??8500)/100,o=(p.otherBps??1500)/100;
  const C=552.92,frac=tm?Math.min(1,Math.max(0,(tm.len-tm.lead)/tm.len)):0.97,ang=frac*2*Math.PI-Math.PI/2,sx=100+88*Math.cos(ang),sy=100+88*Math.sin(ang);
  const settled=(t.cycles||[]).find(c=>big(c.paid_lamports)>0n);
  const lastDone=(t.cycles||[]).find(c=>Number(c.scheduled_end)<=now());
  let last;
  if(settled){const pay=(t.payouts||[]).find(x=>x.cycle_number===settled.cycle_number);
   last='<span>Round #'+esc(settled.cycle_number)+' paid <b class="mono">'+solText(settled.paid_lamports)+' SOL</b> to '+esc(settled.paid_recipients)+' holder'+(settled.paid_recipients==1?'':'s')+'</span>'+tx(pay?.signature,'tx');}
  else if(lastDone)last='<span>Last round #'+esc(lastDone.cycle_number)+': '+esc(ROUND_STATE[lastDone.state]||lastDone.state.replaceAll('_',' '))+(lastDone.reason&&REASON[lastDone.reason]?' ('+esc(REASON[lastDone.reason])+')':'')+'. No round has paid out yet.</span>';
  else last='<span>No round has finished yet.</span>';
  const pills=[paused?'<span class="pill amber">Paused — rounds run as a dry run, nothing is sent</span>':'',!paused&&tm?.c.mode==='dry_run'?'<span class="pill">Dry run</span>':'',tok.test?'<span class="pill">Test token</span>':''].join('');
  const budget=tm&&tm.c.available_lamports!=null?solText(tm.c.available_lamports):null;
  box.innerHTML='<div class="round-top"><div class="ring"><svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="88" class="ring-track"/><circle cx="100" cy="100" r="88" class="ring-bar" id="ring-bar" stroke-dasharray="'+C+'" transform="rotate(-90 100 100)"/><circle cx="'+sx.toFixed(1)+'" cy="'+sy.toFixed(1)+'" r="6" class="ring-snap" id="ring-snap"/></svg>'+
   '<div class="ring-center"><span class="ring-time mono" id="ring-time">'+(tm?mmss(tm.end-now()):'—')+'</span><span class="ring-phase" id="ring-phase">'+(tm?'until payout':'no round')+'</span></div></div>'+
   '<div class="round-info"><span class="round-label"><i class="pulse'+(paused?' amber':'')+'"></i>'+(tm?'Round #'+esc(Number(tm.c.cycle_number).toLocaleString('en-US'))+' · ':'')+esc(sym)+'</span>'+
   '<span class="round-sub">Holder budget this round</span><span class="round-amt mono">'+(budget!=null?budget+' <small>SOL</small>':'— <small>fixed at the snapshot</small>')+'</span>'+
   '<div class="split" aria-hidden="true"><i style="width:'+h+'%"></i><i style="width:'+o+'%"></i></div><div class="split-legend"><span><b>'+h+'%</b> holders</span><span><b class="amber">'+o+'%</b> '+(tok.kind==='primary'?'dev wallet':'buy &amp; burn')+'</span></div>'+
   '<span class="round-snapnote">Snapshot at T−'+(tm?tm.lead:p.cutoffLeadSeconds||60)+' s <i class="dot amber"></i></span></div></div>'+
   (pills?'<div class="round-pills">'+pills+'</div>':'')+'<div class="round-foot">'+last+'</div>';
  clearInterval(st.timer);if(tm){tick();st.timer=setInterval(tick,1000);}
 }
 function tick(){
  if(!alive()){clearInterval(st.timer);return;}const tm=timing();if(!tm)return;
  const n=now(),left=tm.end-n,bar=q('#ring-bar'),time=q('#ring-time'),phase=q('#ring-phase'),snap=q('#ring-snap');
  if(bar)bar.style.strokeDashoffset=(552.92*Math.min(1,Math.max(0,left/tm.len))).toFixed(1);
  if(time)time.textContent=left>0?mmss(left):'0:00';
  const snapped=n>=tm.cut&&left>0;
  if(phase){phase.textContent=left<=0?'settling…':snapped?'Snapshot taken':'until payout';phase.classList.toggle('amber',snapped);}
  if(snap)snap.classList.toggle('flash',snapped);
  const pill=q('#rounds-live');if(pill)pill.textContent=left>0?mmss(left):'settling';
  // The next round is opened by the worker; re-read shortly after this one ends.
  if(left<=-3&&Date.now()-st.refetch>15000){st.refetch=Date.now();api('token',{query:{mint:primary},signal}).then(r=>{if(!alive())return;st.token=r;if(r.now)st.skew=r.now-Math.floor(Date.now()/1000);renderRound();renderRounds();}).catch(()=>{});}
 }

 function renderVerify(err){
  const box=q('#verify-grid');if(!box)return;
  if(err||!st.tokens){box.innerHTML='<p class="muted">On-chain totals are unavailable right now.</p>';return;}
  const list=st.tokens.tokens||[];let paid=0n,holders=0,payouts=0,burned=0n;
  for(const t of list){paid+=big(t.paid_lamports);holders+=Number(t.paid_recipients||0);payouts+=Number(t.payouts||0);burned+=big(t.burned_raw);}
  const dec=Number((st.token?.token?.decimals)??6);st.burned=burned;
  const burnedText=burned>0n?compact(Number(burned)/10**dec):'0';
  const card=(label,id,unit,link)=>'<div class="verify-card"><span class="verify-label">'+label+'</span><span class="verify-num mono"><span id="'+id+'"></span>'+(unit?'<small> '+unit+'</small>':'')+'</span>'+link+'</div>';
  const tokLink='<a class="proof" href="#token/'+esc(primary)+'" data-proof="Opens the token page · every payout with its transaction">Verify ↗</a>';
  box.innerHTML=card('Paid to holders','v-paid','SOL',tokLink)+card('Holders compensated','v-holders','',tokLink)+card('Payouts sent','v-payouts','',tokLink)+
   card('REBOUND burned','v-burned','','<a class="proof" href="https://solscan.io/token/'+esc(primary)+'" target="_blank" rel="noopener noreferrer" data-proof="Opens Solscan · the token’s live supply">Verify ↗</a>')+
   (paid===0n&&payouts===0?'<p class="verify-note muted">Nothing has been paid yet. The first payout will appear here with its transaction.</p>':'');
  const go=()=>{odometer(q('#v-paid'),solText(paid));odometer(q('#v-holders'),holders.toLocaleString('en-US'));odometer(q('#v-payouts'),payouts.toLocaleString('en-US'));odometer(q('#v-burned'),burnedText);};
  // Count up once, when the row comes into view (digits wait at 0 until then).
  if('IntersectionObserver' in window&&!reduced()){for(const [id,v] of [['#v-paid',solText(paid)],['#v-holders',holders.toLocaleString('en-US')],['#v-payouts',payouts.toLocaleString('en-US')],['#v-burned',burnedText]])odometer(q(id),v,true);const io=new IntersectionObserver(e=>{if(e.some(x=>x.isIntersecting)){io.disconnect();go();}},{threshold:.4});io.observe(box);}else go();
 }

 function renderRounds(){
  const box=q('#rounds-table');if(!box)return;const t=st.token;
  if(!t||t.error||!t.cycles?.length){box.innerHTML='<p class="muted">No rounds yet. The first round appears here when the token’s history is verified.</p>';return;}
  const n=now(),rows=t.cycles.slice(0,6).map((c,i)=>{const live=i===0&&Number(c.scheduled_end)>n,pay=(t.payouts||[]).find(x=>x.cycle_number===c.cycle_number);
   const status=live?'<span class="pill live"><i class="pulse"></i><span id="rounds-live">'+mmss(Number(c.scheduled_end)-n)+'</span></span>':pay?tx(pay.signature,ROUND_STATE[c.state]||'Settled'):'<span class="state s-'+esc(c.state)+'">'+esc(ROUND_STATE[c.state]||c.state.replaceAll('_',' '))+'</span>';
   return '<tr><td class="mono">#'+esc(Number(c.cycle_number).toLocaleString('en-US'))+'</td><td class="num">'+(c.available_lamports!=null?solText(c.available_lamports):'—')+'</td><td class="num">'+(c.holders_underwater??'—')+'</td><td class="num '+(big(c.paid_lamports)>0n?'pos':'dim')+'">'+(big(c.paid_lamports)>0n?solText(c.paid_lamports)+' SOL':live?'—':'0')+'</td><td class="st">'+status+'</td></tr>';}).join('');
  box.innerHTML='<table><thead><tr><th>Round</th><th class="num">Holder budget, SOL</th><th class="num">Underwater</th><th class="num">Paid out</th><th class="st">Status</th></tr></thead><tbody>'+rows+'</tbody></table>';
 }

 function renderCoins(err){
  const box=q('#coin-grid');if(!box)return;
  if(err||!st.tokens){box.innerHTML='<p class="muted">The token list is unavailable right now.</p>';return;}
  const list=st.tokens.tokens||[];
  if(!list.length){box.innerHTML='<div class="empty-card"><h3>No tokens yet</h3><p>Tokens launched through REBOUND appear here once they are verified on chain.</p><a class="btn-primary" href="#launch">Launch the first</a></div>';return;}
  box.innerHTML=list.map(t=>{const name=(t.symbol||t.name||'?').trim(),cap=usdPico(t.market_cap_usd_pico);
   const status=t.reward_status==='pair_pending'?['amber','Rounds start with pair support']:t.reward_status==='active'?['mint','Rewards active']:['amber',String(t.reward_status||'pending').replaceAll('_',' ')];
   const img=t.image_uri&&/^https:\/\//.test(t.image_uri)?'<img src="'+esc(t.image_uri)+'" alt="" loading="lazy">':t.featured?'<span class="coin-mark">'+MARK+'</span>':'<span class="coin-ph">'+esc(name.replace(/^\$/,'').slice(0,2).toUpperCase())+'</span>';
   return '<a class="coin-card'+(t.featured?' featured':'')+'" href="#token/'+esc(t.mint)+'"><div class="coin-top">'+img+'<span class="coin-name">$'+esc(name.replace(/^\$/,''))+(t.test?' <i class="pill small">test</i>':'')+'</span><span class="coin-cap mono">'+(cap||'')+'</span></div>'+
    '<div class="coin-stats"><span><b class="mono">'+solText(t.paid_lamports)+'</b> SOL paid</span><span><b class="mono">'+esc(t.paid_recipients||0)+'</b> holders paid</span></div>'+
    '<span class="coin-status '+status[0]+'"><i></i>'+esc(status[1])+'</span></a>';}).join('');
 }

 flow();await load();
 // Live: a payout toast (max one at a time) and fresh totals; a burn shows the burn animation.
 if(!homeChannel)try{homeChannel=await realtime('home-live',[{table:'reward_public_payouts',event:'INSERT'},{table:'reward_public_tokens',event:'UPDATE'}],(table,p)=>{
  const s=homeState;if(!s||!s.host.isConnected)return;
  if(table==='reward_public_payouts'&&p.new){const x=p.new;makeToast(s.host.querySelector('#payout-toast'),'<span class="pay-toast-icon">'+CHECK+'</span><span class="pay-toast-text"><b>+'+solText(x.amount_lamports)+' SOL</b> → '+s.esc(String(x.owner).slice(0,4)+'…'+String(x.owner).slice(-4))+'<small>finalized · '+(x.signature?'<a href="https://solscan.io/tx/'+s.esc(x.signature)+'" target="_blank" rel="noopener noreferrer">tx ↗</a>':'')+'</small></span>');}
  clearTimeout(s.debounce);s.debounce=setTimeout(async()=>{try{const r=await s.api('tokens');if(!homeState||homeState!==s)return;const before=s.burned;s.tokens=r;
   const box=s.host.querySelector('#verify-grid');if(box){box.querySelectorAll('[data-rolled]').forEach(e=>delete e.dataset.rolled);}
   const burned=(r.tokens||[]).reduce((a,t)=>a+big(t.burned_raw),0n);
   if(before!=null&&burned>before){const dec=Number(s.token?.token?.decimals??6);makeToast(s.host.querySelector('#payout-toast'),'<span class="burn-disc" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="pay-toast-text"><b>−'+compact(Number(burned-before)/10**dec)+' REBOUND</b> burned<small><a href="https://solscan.io/token/'+s.esc(s.primary)+'" target="_blank" rel="noopener noreferrer">supply ↗</a></small></span>',4400);}
  }catch{}},900);});}catch{}
}

// ---------------- the "Follow every lamport" diagram ----------------
function flowDiagram(h,o){
 const node=(x,y,w,hh,k,label,cls='')=>'<div class="flow-node '+cls+'" style="left:'+(x/12.8)+'%;top:'+(y/3.6)+'%;width:'+(w/12.8)+'%;height:'+(hh/3.6)+'%"><span class="flow-k">'+k+'</span><span class="flow-l">'+label+'</span></div>';
 const up='M200 180 H840 C910 180 910 70 980 70',down='M200 180 H840 C910 180 910 290 980 290';
 return '<div class="flow-stage"><svg viewBox="0 0 1280 360" preserveAspectRatio="none" aria-hidden="true">'+
  '<path d="M200 180 H300" class="flow-base"/><path d="M500 180 H600" class="flow-base"/><path d="'+up.replace('M200 180 H840','M840 180')+'" class="flow-base"/><path d="'+down.replace('M200 180 H840','M840 180')+'" class="flow-base amber"/>'+
  '<path d="M200 180 H300" class="flow-run"/><path d="M500 180 H600" class="flow-run"/><path d="M840 180 C910 180 910 70 980 70" class="flow-run"/><path d="M840 180 C910 180 910 290 980 290" class="flow-run amber slow"/></svg>'+
  [0,-.9,-1.8,-2.7].map(d=>'<span class="lamport" style="offset-path:path(\''+up+'\');animation-delay:'+d+'s"></span>').join('')+'<span class="lamport amber" style="offset-path:path(\''+down+'\');animation-delay:-2.25s"></span>'+
  node(0,142,200,76,'01','Trades on Pump.fun')+node(300,142,200,76,'02','Creator fees')+node(600,132,240,96,'03','Token’s fee wallet','hub')+
  node(980,26,300,88,h+'%','Underwater holders','mint')+node(980,246,300,88,o+'%','Buy &amp; burn REBOUND<span class="embers" aria-hidden="true"><i></i><i></i><i></i></span>','amber')+'</div>'+
  '<ol class="flow-list"><li><span>01</span>Trades on Pump.fun pay creator fees</li><li><span>02</span>Fees land in the token’s own fee wallet</li><li><span class="mint">'+h+'%</span>Underwater holders, by remaining loss</li><li><span class="amber">'+o+'%</span>Buys and burns REBOUND</li></ol>';
}
const WATERLINE_ART='<svg viewBox="0 0 640 440" preserveAspectRatio="xMidYMid slice"><rect x="0" y="190" width="640" height="250" fill="#0E2A33" opacity=".55"/><line x1="0" y1="190" x2="640" y2="190" stroke="#3AA7C9" stroke-width="2" stroke-dasharray="8 8"/>'+
 '<path d="M20 300 C90 290 130 150 200 170 C250 184 250 120 300 150 C360 186 380 320 450 300 C490 290 505 262 540 268" fill="none" stroke="#EAF5EE" stroke-width="3" stroke-linecap="round"/><circle cx="258" cy="156" r="7" fill="#050F0B" stroke="#EAF5EE" stroke-width="3"/>'+
 '<line x1="540" y1="190" x2="540" y2="268" stroke="#FFB547" stroke-width="2"/><line x1="532" y1="190" x2="548" y2="190" stroke="#FFB547" stroke-width="2"/><circle cx="540" cy="268" r="9" fill="#FFB547"/></svg>'+
 '<div class="wl-wave"><svg viewBox="0 0 800 14"><path d="M0 7 Q30 0 60 7 T120 7 T180 7 T240 7 T300 7 T360 7 T420 7 T480 7 T540 7 T600 7 T660 7 T720 7 T780 7" fill="none" stroke="#3AA7C9" stroke-width="2" opacity=".5"/></svg></div>'+
 '<span class="wl-tag entry">YOUR ENTRY</span><span class="wl-tag now">now</span><span class="wl-tag gap">remaining loss</span><i class="wl-lift"></i><i class="wl-lift"></i><i class="wl-lift"></i>';

// ---------------- wallet check ----------------
export async function mountCheck(host,{api,esc,signal,isAddress,chain,connected}){
 const form=host.querySelector('#check-form'),input=host.querySelector('#check-addr'),err=host.querySelector('#check-err'),panel=host.querySelector('#check-panel'),btn=host.querySelector('#check-go');
 let run=0;
 const idle=()=>{panel.innerHTML='<div class="check-idle"><div class="wl-mini" aria-hidden="true"><div class="wl-mini-water"></div><div class="wl-mini-wave"><svg viewBox="0 0 480 14"><path d="M0 7 Q30 0 60 7 T120 7 T180 7 T240 7 T300 7 T360 7 T420 7 T480 7" fill="none" stroke="#3AA7C9" stroke-width="2"/></svg></div><svg viewBox="0 0 360 180" class="wl-mini-line"><path d="M20 60 C80 50 110 120 170 130 C220 138 250 110 290 118 L340 112" fill="none" stroke="#EAF5EE" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 8"/></svg></div>'+
  '<h3>Paste a wallet to see its waterline</h3><p>We show what it paid for the REBOUND tokens it still holds, what they are worth now, what it has already received — and what is left.</p></div>';};
 idle();
 const setBtn=s=>{btn.dataset.state=s;btn.disabled=s==='busy';btn.querySelector('.press-label').textContent=s==='busy'?'Checking…':s==='done'?'Done':'Check wallet';};
 form.addEventListener('submit',async e=>{
  e.preventDefault();const addr=input.value.trim();
  if(!isAddress(addr)){err.textContent='Paste a full Solana address (32–44 characters).';form.classList.remove('shake');void form.offsetWidth;form.classList.add('shake');input.setAttribute('aria-invalid','true');input.focus();return;}
  err.textContent='';input.removeAttribute('aria-invalid');try{history.replaceState(null,'','#check/'+addr);}catch{}
  const id=++run;setBtn('busy');await analyse(addr,id);if(id===run){setBtn('done');setTimeout(()=>{if(id===run)setBtn('idle');},1400);}
 });
 input.addEventListener('input',()=>{err.textContent='';input.removeAttribute('aria-invalid');});
 host.addEventListener('click',e=>{if(e.target.closest('[data-check-reset]')){run++;input.value='';try{history.replaceState(null,'','#check');}catch{}idle();setBtn('idle');input.focus();}});

 async function analyse(addr,id){
  const short=addr.slice(0,4)+'…'+addr.slice(-4);
  const steps=[['Reading the wallet on Solana mainnet'],['Finding REBOUND tokens it holds or was paid in'],['Pricing positions at the higher of spot and the 15-min average'],['Subtracting compensation already received']];
  const detail=['','','',''];let at=0;
  const draw=()=>{if(id!==run)return;panel.innerHTML='<div class="check-scan"><span class="eyebrow-mono">CHECKING</span><span class="check-addr mono">'+esc(short)+'</span><div class="scan-bar"><i style="width:'+(at/4*100)+'%"></i></div><ol class="scan-steps">'+
   steps.map((s,i)=>'<li class="'+(i<at?'done':i===at?'active':'pending')+'"><span class="scan-icon">'+(i<at?CHECK:'')+'</span><div><b>'+esc(s[0])+'</b><small class="mono">'+esc(i<at?detail[i]:i===at?'reading chain…':'waiting')+'</small></div></li>').join('')+'</ol></div>';};
  const step=async(fn)=>{draw();const t0=Date.now();let r;try{r=await fn();}catch(e){r={text:e?.message?String(e.message).slice(0,80):'unavailable',fail:true};}await sleep(Math.max(0,(reduced()?0:450)-(Date.now()-t0)));detail[at]=r.text;at++;draw();return r;};
  // 1. The wallet's balances (finalized).
  const w=await step(async()=>{const d=await chain('wallet',addr,signal);return{d,text:solText(d.lamports)+' SOL · '+d.tokens.length+' token'+(d.tokens.length===1?'':'s')+' held'};});
  if(id!==run)return;
  // 2. REBOUND tokens: held ones and ones this wallet was ever awarded in.
  const found=await step(async()=>{
   const [prod,test,aw]=await Promise.all([api('tokens',{signal}).catch(()=>({tokens:[]})),api('tokens',{query:{view:'test'},signal}).catch(()=>({tokens:[]})),api('wallet-rewards',{query:{wallet:addr},signal}).catch(()=>({awards:[]}))]);
   const all=new Map();for(const t of [...prod.tokens,...test.tokens])all.set(t.mint,t);
   const held=new Set((w.d?.tokens||[]).map(t=>t.mint)),awarded=new Set((aw.awards||[]).map(a=>a.mint));
   const mine=[...all.values()].filter(t=>held.has(t.mint)||awarded.has(t.mint));
   return{mine,awards:aw.awards||[],text:mine.length?mine.length+' REBOUND token'+(mine.length===1?'':'s')+(held.size?'':' (none held now)'):'none found'};});
  if(id!==run)return;
  // 3. Positions from each token's published holder table (latest verified state).
  const pos=await step(async()=>{
   const out=[];
   for(const t of found.mine||[]){let row=null;
    for(let off=0;off<1000&&!row;off+=500){const h=await api('token-holders',{query:{mint:t.mint,filter:'all',sort:'cost',limit:500,offset:off},signal});row=h.holders.find(x=>x.owner===addr)||null;if(h.offset+h.holders.length>=h.total)break;}
    const info=await api('token',{query:{mint:t.mint},signal}).catch(()=>null);
    out.push({t,row,info});}
   const value=out.reduce((a,x)=>a+big(x.row?.value_lamports),0n);
   return{out,text:out.filter(x=>x.row).length+' position'+(out.filter(x=>x.row).length===1?'':'s')+' · worth '+solText(value)+' SOL now'};});
  if(id!==run)return;
  // 4. What it has already received.
  const paid=await step(async()=>{const p=(found.awards||[]).filter(a=>a.state==='paid'),sum=p.reduce((a,x)=>a+big(x.amount_lamports),0n);return{p,sum,text:solText(sum)+' SOL over '+p.length+' payout'+(p.length===1?'':'s')};});
  if(id!==run)return;
  await sleep(reduced()?0:350);if(id!==run)return;
  result(addr,short,w,found,pos,paid);
 }

 function result(addr,short,w,found,pos,paid){
  const rows=(pos.out||[]).filter(x=>x.row);
  const sum=k=>rows.reduce((a,x)=>a+big(x.row[k]),0n);
  const cost=sum('cost_lamports'),value=sum('value_lamports'),comp=sum('compensated_lamports'),loss=sum('loss_lamports');
  const under=rows.filter(x=>big(x.row.loss_lamports)>0n);
  if(w.fail&&!rows.length){panel.innerHTML='<div class="check-result"><h3>Chain data is unavailable</h3><p class="muted">The wallet could not be read right now ('+esc(w.text)+'). Nothing is estimated in its place — try again in a minute.</p><button type="button" class="btn-ghost" data-check-reset>Check another</button></div>';return;}
  if(!rows.length){panel.innerHTML='<div class="check-result rise"><div class="res-head"><span class="mono muted">'+esc(short)+'</span><span class="pill">No REBOUND positions</span></div><h3>This wallet holds no REBOUND tokens with a recorded purchase</h3><p class="muted">Only purchases of REBOUND tokens count; tokens received by transfer carry no purchase cost. '+(found.mine?.length?'It appears in REBOUND tokens, but not in their current holder tables.':'')+'</p><div class="res-actions"><a class="btn-primary" href="#explore">See REBOUND tokens</a><button type="button" class="btn-ghost" data-check-reset>Check another</button></div></div>';return;}
  const tot=cost>value+comp+loss?cost:value+comp+loss,pct=v=>tot>0n?Number(v*10000n/tot)/100:0;
  const shareRows=under.map(x=>{const st=x.info?.stats,cy=x.info?.cycles?.[0],total=big(st?.loss),mine=big(x.row.loss_lamports);
   const share=total>0n?Number(mine*10000n/total)/100:null;const budget=cy&&cy.available_lamports!=null?big(cy.available_lamports):null;
   let est=null;if(share!=null&&budget!=null){est=budget*mine/(total||1n);if(est>mine)est=mine;}
   const left=cy?Number(cy.cutoff_time)-(x.info?.now||Math.floor(Date.now()/1000)):null;
   return '<div class="estimate"><div><span>Share of the next '+esc((x.t.symbol||x.t.name||'').trim())+' round</span><small>'+(left!=null&&left>0?'Fixed at the snapshot in '+mmss(left)+'. ':'Fixed at each snapshot. ')+'Depends on fees collected and other holders’ losses.</small></div><b class="mono">'+(share!=null?share.toLocaleString('en-US',{maximumFractionDigits:2})+'%':'—')+(est!=null?'<small>≈ '+solText(est)+' SOL at the current budget</small>':'')+'</b></div>';}).join('');
  const excluded=rows.filter(x=>x.row.outcome==='exited');
  const payRows=(paid.p||[]).slice(0,5).map(a=>{const t=(found.mine||[]).find(m=>m.mint===a.mint);return '<div class="paid-row mono"><span class="muted">#'+esc(a.cycle_number)+' · $'+esc((t?.symbol||'').trim()||a.mint.slice(0,4))+'</span><span><b class="mint">+'+solText(a.amount_lamports)+' SOL</b>'+(a.settlement_signature?'<a class="proof" href="https://solscan.io/tx/'+esc(a.settlement_signature)+'" target="_blank" rel="noopener noreferrer" data-proof="Opens Solscan · tx '+esc(a.settlement_signature.slice(0,4)+'…'+a.settlement_signature.slice(-4))+'">tx ↗</a>':'')+'</span></div>';}).join('');
  panel.innerHTML='<div class="check-result">'+
   '<div class="res-head rise"><span class="mono muted">'+esc(short)+'</span>'+(under.length?'<span class="pill amber">Underwater on '+under.length+' token'+(under.length===1?'':'s')+'</span>':'<span class="pill mint">Above the waterline</span>')+'</div>'+
   '<div class="res-loss rise d1"><span>Remaining loss</span><b class="mono '+(loss>0n?'amber':'')+'">'+solText(loss,4)+' <small>SOL</small></b></div>'+
   '<div class="res-bar rise d2"><div class="bar3" aria-hidden="true"><i style="width:'+pct(value)+'%"></i><i class="mint" style="width:'+pct(comp)+'%"></i><i class="amber" style="width:'+pct(loss)+'%"></i></div>'+
   '<div class="bar3-legend"><div><span><i></i>Value now</span><b class="mono">'+solText(value,4)+' SOL</b></div><div><span><i class="mint"></i>Already received</span><b class="mono">'+solText(comp,4)+' SOL</b></div><div><span><i class="amber"></i>Still to recover</span><b class="mono">'+solText(loss,4)+' SOL</b></div></div>'+
   '<small class="muted">Of '+solText(cost,4)+' SOL paid for the tokens this wallet still holds (first in, first out). Losses are measured in SOL.</small></div>'+
   (shareRows?'<div class="rise d3">'+shareRows+'</div>':'')+
   (excluded.length?'<p class="note amber rise d3">'+excluded.map(x=>'$'+esc((x.t.symbol||'').trim())).join(', ')+': sold or transferred — excluded from later rounds for good.</p>':'')+
   '<div class="paid-list rise d4"><span class="muted">Paid to this wallet</span>'+(payRows||'<p class="muted small">No payouts yet.</p>')+'</div>'+
   '<div class="res-actions rise d5">'+(connected?'<a class="btn-primary" href="#portfolio">Follow your payouts</a>':'<button type="button" class="btn-primary" data-action="wallet">Connect to follow payouts</button>')+'<button type="button" class="btn-ghost" data-check-reset>Check another</button></div></div>';
 }
 const pre=input.value.trim();if(pre&&isAddress(pre)&&location.hash.startsWith('#check/'))form.requestSubmit();
}
