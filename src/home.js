/* Home ("the bounce", canvas v3) and wallet check. Read-only views over the public API: home, config,
   wallet-check, token-holders, token, tokens, wallet-rewards and the chain endpoint. Nothing here signs,
   submits or changes reward state. Every figure comes from those reads and stays live over Supabase
   Realtime (polling only while the websocket is down); when a read is empty or fails, the view says so
   instead of showing an example. */

const LAMPORTS=1000000000n;
const big=v=>{try{return BigInt(String(v??0).split('.')[0]);}catch{return 0n;}};
/** SOL with up to `d` decimals (trailing zeros trimmed); tiny non-zero amounts show as <0.001. */
export function solText(lamports,d=3){const v=big(lamports);if(v===0n)return '0';const neg=v<0n,a=neg?-v:v;
 const unit=10n**BigInt(9-d);if(a<unit)return (neg?'−':'')+'<'+(1/10**d).toFixed(d);
 const whole=a/LAMPORTS,frac=String((a%LAMPORTS)/unit).padStart(d,'0').replace(/0+$/,'');
 return (neg?'−':'')+whole.toLocaleString('en-US')+(frac?'.'+frac:'');}
const compact=n=>{const x=Number(n);if(!Number.isFinite(x))return '—';if(x<1000)return x.toLocaleString('en-US',{maximumFractionDigits:2});
 const u=[['T',1e12],['B',1e9],['M',1e6],['K',1e3]].find(([,v])=>x>=v);return (x/u[1]).toLocaleString('en-US',{maximumFractionDigits:2})+u[0];};
const mmss=s=>{s=Math.max(0,Math.floor(s));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const hhmm=t=>new Date(Number(t)*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
const hhmmss=t=>new Date(Number(t)*1000).toLocaleTimeString();
const reduced=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const shortAddr=a=>a.length>12?a.slice(0,4)+'…'+a.slice(-4):a;
const CHECK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
export const ROUND_STATE={scheduled:'Scheduled',snapshotting:'Taking snapshot',waiting_for_data:'Taking snapshot',funded:'Reserved — paying at round end',paying:'Paying',partially_paid:'Partly paid',complete:'Settled',dry_run:'Dry run — nothing sent',skipped_no_funds:'No funds this round',skipped_no_eligible_holders:'Nobody underwater',missed:'Skipped'};
const REASON={paused:'paused',snapshot_window_closed:'snapshot window closed',price_window_incomplete:'waiting for a 15-minute price',history_incomplete:'loading history',history_behind_cutoff:'verifying trades',positions_behind_cutoff:'applying trades',cutoff_slot_unproven:'confirming the snapshot slot',fee_wallet_key_missing:'fee wallet key missing',dry_run:'dry run',no_funds:'no funds',budget_used_up:'budget used up',no_new_fees:'no new fees'};
const PRE=['scheduled','snapshotting','waiting_for_data'],CATCHING=['history_behind_cutoff','positions_behind_cutoff','history_incomplete','cutoff_slot_unproven'];
const SETTLED=['funded','paying','partially_paid','complete'];

// The arrow-clock: one round runs along the arrow from its start (left) to the payout at the tip.
const ARROW='M132 144 V288 A144 144 0 0 0 420 288 V96',HEAD='M324 176 L420 80 L500 176';

// ---------------- home ----------------
let homeChannel=null,homeState=null,rtStatus='';
export async function mountHome(host,{api,realtime,esc,signal,isAddress}){
 const st={host,esc,api,data:null,cfg:null,skew:0,timer:null,refetch:0,known:null,lastPaid:null,shown:{},phase:'idle',tl:[]};homeState=st;
 const q=s=>host.querySelector(s);
 const alive=()=>host.isConnected&&homeState===st&&!signal?.aborted;
 const now=()=>Math.floor(Date.now()/1000)+st.skew;

 buildClock();
 wireCheck();
 const load=async()=>{
  st.refetch=Date.now();
  const [home,cfg]=await Promise.allSettled([api('home',{signal}),st.cfg?Promise.resolve(st.cfg):api('config',{signal})]);
  if(!alive())return;
  if(cfg.status==='fulfilled')st.cfg=cfg.value;
  if(home.status==='rejected'){st.error=home.reason;if(!st.data){renderError();}return;}
  st.error=null;const d=home.value;if(d.now)st.skew=d.now-Math.floor(Date.now()/1000);
  const first=!st.data;st.data=d;
  lede();renderStats(first);renderCoins(first);renderPayouts();setupClock();detectPayout(first);
 };

 function lede(){const p=st.cfg?.policy||{},h=(p.holdersBps??8500)/100,mins=p.cycleSeconds?Math.round(p.cycleSeconds/60):30;
  const el=q('#home-lede');if(el)el.textContent=h+'% of every rebound coin’s creator fees goes to holders who are underwater. The deeper you are, the bigger your share. Paid in SOL every '+mins+' minutes.';}
 function renderError(){const msg='Live data is unavailable right now. Nothing is estimated in its place.';
  const t=q('#coin-table');if(t)t.innerHTML='<p class="muted">'+esc(msg)+'</p>';const p=q('#payout-rows');if(p)p.innerHTML='<p class="muted">'+esc(msg)+'</p>';
  renderStats(true);setupClock();}

 // ---------- the arrow-clock ----------
 function buildClock(){
  const c=q('#clock');if(!c)return;
  c.innerHTML='<svg class="ck-svg" viewBox="0 0 560 500" aria-hidden="true"><path class="ck-track" d="'+ARROW+'"/><path class="ck-track" d="'+HEAD+'"/>'+
   '<path class="ck-trail" id="ck-trail" d="'+ARROW+'" pathLength="1"/><line class="ck-snap" id="ck-snap" x1="440" y1="122" x2="456" y2="122"/>'+
   '<g class="ck-headg"><path class="ck-head" d="'+HEAD+'"/></g></svg>'+
   '<span class="ck-dot idle" id="ck-dot" aria-hidden="true"></span>'+
   '<span class="ck-start" id="ck-start"></span><span class="ck-snaplabel" id="ck-snaplabel">snapshot</span><span class="ck-tip" id="ck-tip"></span>'+
   '<div class="ck-center"><span class="ck-time" id="ck-time">—</span><span class="ck-label" id="ck-label">Reading the current round…</span><span class="ck-proc" id="ck-proc" hidden></span></div>'+
   '<div class="ck-burst" id="ck-burst" aria-hidden="true"></div><span class="ck-pill" id="ck-pill" role="status"></span>'+
   '<button type="button" class="ghost-link ck-preview" id="ck-preview">Preview a payout</button>';
  q('#ck-preview').addEventListener('click',()=>{const last=lastPaidRound();
   burst(last?'Last payout: +'+solText(last.paid_lamports)+' SOL to '+last.paid_recipients+' holder'+(last.paid_recipients==1?'':'s'):'Preview — no payout yet',true);});
 }
 function head(){return st.data?.headline||null;}
 function timing(){const h=head(),cs=h?.cycles||[],c=cs[0];if(!c)return null;
  let len=Number(st.cfg?.policy?.cycleSeconds||1800);
  // Round length: the shortest spacing between recent rounds (a round that waited at its snapshot only lengthens one).
  let best=null;for(let i=1;i<cs.length;i++){const dn=cs[i-1].cycle_number-cs[i].cycle_number,de=Number(cs[i-1].scheduled_end)-Number(cs[i].scheduled_end);if(dn>0&&de>0){const v=de/dn;if(best==null||v<best)best=v;}}if(best)len=best;
  const end=Number(c.scheduled_end),cut=Number(c.cutoff_time);return{c,len,end,cut,start:end-len,lead:Math.max(0,end-cut)};}
 const pathEl=()=>q('#ck-trail');
 function pointAt(f){const p=pathEl();if(!p?.getTotalLength)return null;const L=p.getTotalLength();return p.getPointAtLength(Math.max(0,Math.min(1,f))*L);}
 function setupClock(){
  const tm=timing(),h=head();
  // Snapshot tick: a short mark beside the arrow where the snapshot falls in the round.
  if(tm){const f=(tm.len-tm.lead)/tm.len,pt=pointAt(f),pa=pointAt(f-.004),pb=pointAt(f+.004),line=q('#ck-snap'),lab=q('#ck-snaplabel');
   if(pt&&pa&&pb&&line){let nx=pb.y-pa.y,ny=-(pb.x-pa.x);const n=Math.hypot(nx,ny)||1;nx/=n;ny/=n;if(nx*(pt.x-276)+ny*(pt.y-288)<0){nx=-nx;ny=-ny;}
    line.setAttribute('x1',(pt.x+nx*20).toFixed(1));line.setAttribute('y1',(pt.y+ny*20).toFixed(1));line.setAttribute('x2',(pt.x+nx*36).toFixed(1));line.setAttribute('y2',(pt.y+ny*36).toFixed(1));
    lab.style.left=(pt.x+nx*44).toFixed(0)+'px';lab.style.top=(pt.y+ny*44-10).toFixed(0)+'px';}
   q('#ck-start').textContent=hhmm(tm.start);q('#ck-tip').textContent=hhmm(tm.end)+' payout';}
  q('#ck-snap').style.display=q('#ck-snaplabel').style.display=tm?'':'none';
  if(!tm){q('#ck-start').textContent='';q('#ck-tip').textContent='';}
  clearInterval(st.timer);tick();st.timer=setInterval(tick,1000);
 }
 function nsPaused(){const h=head();if(!h)return false;const coin=(st.data?.coins||[]).find(c=>c.mint===h.mint);const ns=(st.cfg?.namespaces||[]).find(n=>n.namespace===(coin?.featured?st.cfg?.siteSettings?.namespace:'production'));return !!ns?.paused;}
 function procText(tm){const h=head()||{},reason=tm.c.reason;
  if(h.history_complete===false&&Number(h.history_total)>0){const f=Number(h.history_fetched||0),T=Number(h.history_total);return 'Loading trade history: '+f.toLocaleString('en-US')+' of '+T.toLocaleString('en-US')+' transactions';}
  if(reason&&!CATCHING.includes(reason))return 'Waiting: '+(REASON[reason]||reason.replaceAll('_',' '));
  const pos=Number(h.positions_time||0);return pos?'Trades verified through '+hhmmss(pos):'Verifying trades up to '+hhmmss(tm.cut);}
 // Snapshot state comes from the worker, never from the clock: at the cutoff the clock holds (and says what
 // is being verified) until the round's snapshot has really been taken; the payout countdown then resumes.
 function tick(){
  if(!alive()){clearInterval(st.timer);return;}
  const tm=timing(),h=head(),time=q('#ck-time'),label=q('#ck-label'),proc=q('#ck-proc'),dot=q('#ck-dot'),trail=q('#ck-trail'),clock=q('#clock');if(!time)return;
  const set=f=>{if(st.phase!=='idle')return;dot.style.offsetDistance=(f*100).toFixed(2)+'%';trail.style.strokeDashoffset=(1-f).toFixed(4);};
  if(!tm){dot.classList.add('idle');set(0);time.textContent='—';proc.hidden=true;
   label.textContent=st.error?'Round data is unavailable right now':!st.data?'Reading the current round…':(st.data.coins||[]).length?'No round is running yet':'Rounds start with the first coin';return;}
  const n=now(),left=tm.end-n,holding=n>=tm.cut&&PRE.includes(tm.c.state),paused=nsPaused();
  dot.classList.toggle('idle',paused);clock.classList.toggle('holding',holding);
  const f=holding?(tm.len-tm.lead)/tm.len:Math.min(1,Math.max(0,(n-tm.start)/tm.len));set(f);
  time.textContent=mmss(holding?tm.lead:Math.max(0,left));
  const num=Number(tm.c.cycle_number).toLocaleString('en-US'),coin=(st.data.coins||[]).find(c=>c.mint===h.mint),sym=coin&&!coin.featured?' on $'+(h.symbol||h.name||'').replace(/^\$/,''):'';
  label.textContent=holding?'Taking the snapshot…':paused?'Rounds are paused':left<=0?(SETTLED.includes(tm.c.state)&&tm.c.state!=='complete'?'Round '+num+' is paying out…':'Round '+num+' is settling…'):'until round '+num+sym+' pays out';
  proc.hidden=!holding;if(holding)proc.textContent=procText(tm);
  // Re-read while the snapshot is pending (every 5 s) and after the round ends (every 10 s); realtime covers the rest.
  if((holding&&Date.now()-st.refetch>5000)||(left<=-2&&Date.now()-st.refetch>10000)||(rtStatus!=='SUBSCRIBED'&&Date.now()-st.refetch>30000))load().catch(()=>{});
 }
 function lastPaidRound(){return (head()?.cycles||[]).find(c=>big(c.paid_lamports)>0n)||null;}
 // A real payout on the headline coin plays the payout animation once; the first load only remembers it.
 function detectPayout(first){const last=lastPaidRound();const key=last?head().mint+':'+last.cycle_number:null;
  if(first||st.lastPaid==null){st.lastPaid=key||'';return;}
  if(key&&key!==st.lastPaid){st.lastPaid=key;burst('+'+solText(last.paid_lamports)+' SOL to '+last.paid_recipients+' holder'+(last.paid_recipients==1?'':'s'),false);}}
 function burst(text,preview){
  const c=q('#clock'),dot=q('#ck-dot'),trail=q('#ck-trail'),pill=q('#ck-pill'),btn=q('#ck-preview'),b=q('#ck-burst');if(!c)return;
  st.tl.forEach(clearTimeout);pill.textContent=text;
  if(reduced()){c.classList.add('paid');st.tl=[setTimeout(()=>{c.classList.remove('paid');},3000)];return;}
  st.phase='run';c.classList.remove('paid','back');c.classList.add('run');if(preview)btn.textContent='Paying out…';
  dot.style.offsetDistance='100%';trail.style.strokeDashoffset='0';
  b.innerHTML='<i class="p0"></i><i class="p1"></i><i class="p2"></i><svg class="p3" viewBox="0 0 10 10"><path d="M5 .6 9.6 9.2H.4Z"/></svg><i class="p4"></i><svg class="p5" viewBox="0 0 10 10"><path d="M5 .6 9.6 9.2H.4Z"/></svg>';
  st.tl=[setTimeout(()=>{c.classList.remove('run');c.classList.add('paid');btn.textContent='Preview a payout';},1100),
   setTimeout(()=>{c.classList.remove('paid');c.classList.add('back');st.phase='back';b.innerHTML='';st.phase='idle';tick();},4000),
   setTimeout(()=>{c.classList.remove('back');},4700)];
 }

 // ---------- stats ----------
 function tween(el,to,fmt,animate){if(!el)return;const from=Number(el.dataset.v||0);el.dataset.v=to;
  if(!animate||reduced()||from===to){el.textContent=fmt(to);return;}
  const t0=performance.now(),D=1400;const step=t=>{const p=Math.min(1,(t-t0)/D),e=1-Math.pow(1-p,3);el.textContent=fmt(from+(to-from)*e);if(p<1&&el.isConnected)requestAnimationFrame(step);};requestAnimationFrame(step);}
 function renderStats(first){
  const box=q('#stats');if(!box)return;const d=st.data,coins=d?.coins||[];
  if(!box.firstChild)box.innerHTML='<div><span class="st-num"><span id="st-pool">—</span> <small>SOL</small></span><span class="st-label" id="st-pool-l">in this round’s pool, across all coins</span></div>'+
   '<div><span class="st-num" id="st-under">—</span><span class="st-label">holders underwater right now</span></div>'+
   '<div><span class="st-num"><span id="st-paid">—</span> <small>SOL</small></span><span class="st-label">paid back to holders so far</span></div>'+
   '<div><span class="st-num" id="st-burn">—</span><span class="st-label" id="st-burn-l">$REBOUND bought and burned</span></div>';
  if(!d)return;
  let pool=0n,known=false,under=0,paid=0n,burned=0n;
  for(const c of coins){under+=Number(c.underwater||0);paid+=big(c.paid_lamports);burned+=big(c.burned_raw);
   const r=c.round;if(r&&r.available_lamports!=null&&(PRE.includes(r.state)||['funded','paying'].includes(r.state))){pool+=big(r.available_lamports);known=true;}}
  const dec=Number(coins.find(c=>c.featured)?.decimals??6),sym=(st.cfg?.siteSettings?.symbol||'REBOUND').replace(/^\$/,'');
  const sol=v=>solText(BigInt(Math.round(v)),3);
  if(known)tween(q('#st-pool'),Number(pool),sol,first);else{q('#st-pool').textContent='—';q('#st-pool').dataset.v=0;}
  q('#st-pool-l').textContent=known?'in this round’s pool, across all coins':'in this round’s pool — fixed at each snapshot';
  tween(q('#st-under'),under,v=>Math.round(v).toLocaleString('en-US'),first);
  tween(q('#st-paid'),Number(paid),sol,first);
  tween(q('#st-burn'),Number(burned)/10**dec,v=>v>0?compact(v):'0',first);
  q('#st-burn-l').textContent='$'+sym+' bought and burned';
 }

 // ---------- coins ----------
 let showAll=false;
 function coinNote(c){if(c.featured)return 'paid by the dev wallet';const age=c.launch_time?now()-Number(c.launch_time):null;
  if(age!=null&&age<48*3600)return age<3600?Math.max(1,Math.floor(age/60))+' min old':Math.floor(age/3600)+(Math.floor(age/3600)===1?' hour old':' hours old');return '';}
 function thisRound(c){const r=c.round;
  if(c.reward_status==='pair_pending')return ['muted','Not paying yet: '+(c.quote_symbol||'pair')+' rounds start later'];
  if(!r)return ['muted',c.history_complete===false?'Not paying yet: loading its trade history':'Not paying yet: waiting for its first round'];
  if(r.available_lamports!=null&&big(r.available_lamports)>0n&&!['complete','skipped_no_eligible_holders','missed','skipped_no_funds'].includes(r.state))return ['pos',solText(r.available_lamports)+' SOL'];
  if(c.holders>0&&c.underwater===0)return ['muted','Nobody’s under, fees roll over'];
  if(r.mode==='dry_run'||r.state==='dry_run')return ['muted','Dry run, nothing is sent'];
  if(PRE.includes(r.state))return ['muted',r.reason&&CATCHING.includes(r.reason)?'Verifying trades for the snapshot':'Fixed at the snapshot'];
  if(r.state==='skipped_no_funds')return ['muted','No new fees this round'];
  return ['muted',ROUND_STATE[r.state]||r.state.replaceAll('_',' ')];}
 function renderCoins(first){
  const box=q('#coin-table');if(!box)return;const coins=st.data?.coins||[];
  const prev=st.known;st.known=new Set(coins.map(c=>c.mint));
  if(!coins.length){box.innerHTML='<div class="b-empty"><p>No coins yet. Coins launched on rebound show up here the moment they are live.</p><a class="ink" href="#launch">Launch the first coin</a></div>';q('#coins-all').hidden=true;return;}
  const LIMIT=6,list=showAll?coins:coins.slice(0,LIMIT);
  box.innerHTML='<table class="coins"><thead><tr><th class="c-coin">Coin</th><th class="c-under">Underwater</th><th class="c-paid">Paid back so far</th><th class="c-round">This round</th></tr></thead><tbody>'+list.map(c=>{
   const name=(c.name||c.symbol||c.mint.slice(0,4)).trim(),sym=(c.symbol||'').replace(/^\$/,'').trim(),note=coinNote(c),[cls,txt]=thisRound(c);
   const fresh=!first&&prev&&!prev.has(c.mint);
   return '<tr class="row'+(fresh?' fresh':'')+'" data-href="#token/'+esc(c.mint)+'"><td class="c-coin"><a href="#token/'+esc(c.mint)+'"><b title="'+esc(name)+'">'+esc(name)+'</b></a> <span class="muted">'+esc(sym)+(note?' · '+esc(note):'')+'</span><span class="c-mob muted">'+(c.holders?esc(c.underwater)+' under':'')+'</span></td>'+
    '<td class="c-under'+(c.holders?'':' muted')+'">'+(c.holders?esc(c.underwater)+' of '+esc(c.holders):'—')+'</td>'+
    '<td class="c-paid'+(big(c.paid_lamports)>0n?'':' muted')+'">'+(big(c.paid_lamports)>0n?solText(c.paid_lamports,1)+' SOL':'—')+'</td>'+
    '<td class="c-round '+cls+'">'+esc(txt)+'</td></tr>';}).join('')+'</tbody></table>';
  const all=q('#coins-all');all.hidden=coins.length<=LIMIT;all.textContent=showAll?'Show fewer':'All '+coins.length+' coins';all.onclick=()=>{showAll=!showAll;renderCoins(false);};
  box.querySelectorAll('tr[data-href]').forEach(tr=>tr.addEventListener('click',e=>{if(!e.target.closest('a'))location.hash=tr.dataset.href;}));
 }

 // ---------- latest payouts (per round) ----------
 function renderPayouts(){
  const box=q('#payout-rows');if(!box)return;const d=st.data,rounds=d?.rounds||[],coins=d?.coins||[],many=coins.length>1;
  const all=q('#payouts-all');if(d?.headline){all.hidden=false;all.href='#token/'+d.headline.mint;}else all.hidden=true;
  if(!rounds.length){box.innerHTML='<p class="muted b-empty-line">No round has paid out yet. The first payout shows here with its transactions.</p>';return;}
  box.innerHTML=rounds.map((r,i)=>{const coin=coins.find(c=>c.mint===r.mint),sym=(coin?.symbol||'').replace(/^\$/,'').trim(),num=Number(r.cycle_number).toLocaleString('en-US');
   const txs=Number(r.txs||0),link=txs===1&&r.signature?'<a href="https://solscan.io/tx/'+esc(r.signature)+'" target="_blank" rel="noopener noreferrer">1 transaction</a>':txs>1?'<a href="#token/'+esc(r.mint)+'">'+txs+' transactions</a>':'<a href="#token/'+esc(r.mint)+'">round details</a>';
   const body=big(r.paid_lamports)>0n?'<span><b class="pos">'+solText(r.paid_lamports)+' SOL</b> to '+esc(r.paid_recipients)+' holder'+(r.paid_recipients==1?'':'s')+(many&&sym?' · $'+esc(sym):'')+'</span>'
    :'<span class="muted">Nobody was underwater. '+(r.available_lamports!=null&&big(r.available_lamports)>0n?solText(r.available_lamports)+' SOL rolled into '+(Number(r.cycle_number)+1).toLocaleString('en-US')+'.':'Fees rolled into the next round.')+(many&&sym?' · $'+esc(sym):'')+'</span>';
   return '<div class="pay-row'+(i===0?' first':'')+'"><b>'+num+'</b>'+body+link+'</div>';}).join('');
 }

 // ---------- check a wallet (inline) ----------
 function wireCheck(){
  const form=q('#hero-check'),input=q('#hc-addr'),err=q('#hc-err'),out=q('#hc-out'),btn=q('#hc-go'),ex=q('#hc-example');if(!form)return;
  let run=0;
  const idle=()=>{ex.hidden=!st.example;};
  const fail=text=>{err.textContent=text;out.innerHTML='';ex.hidden=true;const row=form.querySelector('.hc-row');row.classList.remove('shake');void row.offsetWidth;row.classList.add('shake');input.setAttribute('aria-invalid','true');};
  input.addEventListener('input',()=>{err.textContent='';input.removeAttribute('aria-invalid');if(!input.value.trim()){out.innerHTML='';idle();}});
  form.addEventListener('submit',async e=>{e.preventDefault();const a=input.value.trim();
   if(!a)return fail('Paste an address first.');if(!isAddress(a))return fail('That isn’t a Solana address. It should be 32–44 characters, without 0, O, I or l.');
   err.textContent='';input.removeAttribute('aria-invalid');ex.hidden=true;const id=++run;btn.disabled=true;btn.textContent='Checking…';
   try{const r=await api('wallet-check',{query:{wallet:a},signal});if(id!==run||!alive())return;out.innerHTML=result(a,r);}
   catch(x){if(id===run&&alive())out.innerHTML='<span class="hc-line muted">The check is unavailable right now ('+esc(x.message||'error')+'). Nothing is estimated in its place.</span>';}
   finally{if(id===run){btn.disabled=false;btn.textContent='Check';}}});
  ex.addEventListener('click',()=>{if(!st.example)return;input.value=st.example;form.requestSubmit();});
  st.idleCheck=idle;
 }
 function result(addr,r){
  const s='<b>'+esc(shortAddr(addr))+'</b>',pos=r.positions||[],under=pos.filter(p=>big(p.loss_lamports)>0n),paid=r.paid||{lamports:'0',payouts:0};
  const more='<a class="hc-more" href="#check/'+esc(addr)+'">Full breakdown</a>';
  const paidLine=big(paid.lamports)>0n?solText(paid.lamports)+' SOL already paid back over '+paid.payouts+' payout'+(paid.payouts==1?'':'s'):'nothing paid back yet';
  if(!pos.length)return '<span class="hc-line">'+s+' holds no rebound coins with a recorded purchase.</span><span class="hc-detail">Only purchases count; tokens received by transfer carry no cost. '+more+'</span>';
  if(!under.length)return '<span class="hc-line">'+s+' isn’t underwater on any rebound coin. Nothing to pay back right now.</span><span class="hc-detail">'+esc(paidLine[0].toUpperCase()+paidLine.slice(1))+'. '+more+'</span>';
  const p=under[0],sym=(p.symbol||p.name||'').replace(/^\$/,'').trim()||p.mint.slice(0,4);
  const gets=p.estimate_lamports!=null?' This round it gets about <b class="pos">'+solText(p.estimate_lamports)+' SOL</b>.':p.share_bps?' Its share of the next payout is <b class="pos">'+(p.share_bps/100).toLocaleString('en-US',{maximumFractionDigits:2})+'%</b>, fixed at the snapshot.':'';
  return '<span class="hc-line">'+s+' is <b class="neg">'+solText(p.loss_lamports)+' SOL under</b> on '+esc(sym)+'.'+gets+'</span>'+
   '<span class="hc-detail">Paid '+solText(p.cost_lamports)+' SOL for what it still holds, worth '+solText(p.value_lamports)+' SOL now, '+esc(paidLine)+(under.length>1?' · underwater on '+under.length+' coins':'')+'. '+more+'</span>';
 }
 // Example wallet: the holder with the biggest remaining loss on the headline coin (a real, public position).
 async function findExample(){const h=head();if(!h||st.example)return;
  try{const r=await api('token-holders',{query:{mint:h.mint,filter:'underwater',sort:'loss',limit:1},signal});st.example=r.holders?.[0]?.owner||null;}catch{}
  if(alive()&&!q('#hc-out').innerHTML&&!q('#hc-err').textContent)st.idleCheck?.();}

 await load();findExample();
 // Live for everyone: new coins, round changes and payouts arrive over the websocket; a burst of events
 // becomes one re-read. While the socket is down the clock's tick polls every 30 s instead.
 const refresh=()=>{const s=homeState;if(!s)return;clearTimeout(s.debounce);s.debounce=setTimeout(()=>{if(homeState===s&&s.host.isConnected)s.reload();},600);};
 st.reload=()=>load().catch(()=>{});
 if(!homeChannel)try{homeChannel=await realtime('home-live',[{table:'reward_public_tokens'},{table:'reward_public_cycles'},{table:'reward_public_payouts',event:'INSERT'},{table:'reward_site',event:'UPDATE'}],()=>refresh(),s=>{rtStatus=s;document.documentElement.dataset.realtime=String(s).toLowerCase();});}catch{rtStatus='CHANNEL_ERROR';}
}

// ---------------- wallet check ----------------
export async function mountCheck(host,{api,esc,signal,isAddress,chain,connected}){
 const form=host.querySelector('#check-form'),input=host.querySelector('#check-addr'),err=host.querySelector('#check-err'),panel=host.querySelector('#check-panel'),btn=host.querySelector('#check-go');
 let run=0;
 const idle=()=>{panel.innerHTML='<div class="check-idle"><div class="wl-mini" aria-hidden="true"><div class="wl-mini-water"></div><div class="wl-mini-wave"><svg viewBox="0 0 480 14"><path d="M0 7 Q30 0 60 7 T120 7 T180 7 T240 7 T300 7 T360 7 T420 7 T480 7" fill="none" stroke="#7FD8E6" stroke-width="2"/></svg></div><svg viewBox="0 0 360 180" class="wl-mini-line"><path d="M20 60 C80 50 110 120 170 130 C220 138 250 110 290 118 L340 112" fill="none" stroke="#F4EFE3" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 8"/></svg></div>'+
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
   const [prod,test,aw]=await Promise.all([api('tokens',{signal}).catch(()=>({tokens:[]})),Promise.resolve({tokens:[]}),api('wallet-rewards',{query:{wallet:addr},signal}).catch(()=>({awards:[]}))]);
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
