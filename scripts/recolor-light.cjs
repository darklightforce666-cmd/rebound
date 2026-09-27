'use strict';
// One-off migration (kept for the record): maps the dark "Proof in motion" v2 palette onto the light
// "the bounce" palette (canvas v3). Every colour is matched to the nearest point on one of the v2 ramps
// (neutral water, lime payouts, orange burn, aqua waterline) and replaced by the same point on the light
// ramp: dark surfaces become paper, cream ink becomes near-black, lime becomes the payout green.
// Alpha is kept; black shadows stay black but lighter.
const fs=require('node:fs');
const hex=h=>{h=h.slice(1);if(h.length<=4)h=[...h].map(c=>c+c).join('');return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16),a:h.length===8?h.slice(6,8):''};};
const toHex=({r,g,b})=>'#'+[r,g,b].map(v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('').toUpperCase();
const mix=(a,b,t)=>({r:a.r+(b.r-a.r)*t,g:a.g+(b.g-a.g)*t,b:a.b+(b.b-a.b)*t});
const ramp=(stops,x)=>{for(let i=1;i<stops.length;i++)if(x<=stops[i][0]){const [x0,c0]=stops[i-1],[x1,c1]=stops[i];return mix(hex(c0),hex(c1),(x-x0)/(x1-x0||1));}return hex(stops.at(-1)[1]);};
// v2 ramps (scripts/recolor-css.cjs) and their light counterparts, stop for stop.
const V2={
 neutral:[[0,'#03110C'],[.055,'#06231B'],[.085,'#0A2A21'],[.115,'#0E3127'],[.16,'#15392E'],[.2,'#1B4135'],[.28,'#2A5244'],[.45,'#8FAD9F'],[.62,'#A9C2B6'],[.8,'#D8DDD0'],[.95,'#F4EFE3'],[1,'#FBF8F1']],
 mint:[[0,'#06231B'],[.12,'#0F3529'],[.25,'#1E7A56'],[.55,'#D4F46A'],[.8,'#E6FAA8'],[1,'#F7FFE0']],
 amber:[[0,'#1A0A04'],[.15,'#3A1D10'],[.55,'#FF7A45'],[.8,'#FFB08F'],[1,'#FFF0E8']],
 teal:[[0,'#03161A'],[.15,'#0B2B30'],[.5,'#7FD8E6'],[.8,'#C2EEF5'],[1,'#F0FCFE']],
};
const LIGHT={
 neutral:[[0,'#FFFFFF'],[.055,'#F7F7F4'],[.085,'#FFFFFF'],[.115,'#F4F4F0'],[.16,'#EDEDE7'],[.2,'#E3E3DD'],[.28,'#D5D5CE'],[.45,'#9A9F9B'],[.62,'#6B716D'],[.8,'#4A514D'],[.95,'#0D1310'],[1,'#0D1310']],
 mint:[[0,'#F7F7F4'],[.12,'#E7F3EC'],[.25,'#CBE7D8'],[.55,'#0B7A4C'],[.8,'#0F9D63'],[1,'#0F9D63']],
 amber:[[0,'#FBF3EF'],[.15,'#F5DED3'],[.55,'#C2461B'],[.8,'#A23A15'],[1,'#7A2B0F']],
 teal:[[0,'#F2F6F6'],[.15,'#DCEAEC'],[.5,'#2F7F8C'],[.8,'#235F69'],[1,'#173F46']],
};
const SAMPLES=[];for(const k of Object.keys(V2))for(let i=0;i<=400;i++){const x=i/400;SAMPLES.push({k,x,c:ramp(V2[k],x)});}
const d2=(a,b)=>(a.r-b.r)**2+(a.g-b.g)**2+(a.b-b.b)**2;
function map(c){
 if(c.r+c.g+c.b<=6)return c;   // pure black (shadows) stays black
 let best=null,bd=Infinity;for(const s of SAMPLES){const d=d2(c,s.c);if(d<bd){bd=d;best=s;}}
 return ramp(LIGHT[best.k],best.x);}
const black=c=>c.r+c.g+c.b<=6;
const lighter=a=>Math.max(.04,Math.round(parseFloat(a)*.35*100)/100);
function recolor(css){
 return css.replace(/#[0-9a-fA-F]{3,8}\b/g,m=>{if(![4,5,7,9].includes(m.length))return m;const c=hex(m);
   if(black(c)&&c.a)return '#000000'+Math.round(Math.max(10,parseInt(c.a,16)*.35)).toString(16).padStart(2,'0').toUpperCase();
   return toHex(map(c))+(c.a?c.a.toUpperCase():'');})
  .replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g,(m,r,g,b,a)=>{const c={r:+r,g:+g,b:+b};if(black(c))return `rgba(0,0,0,${lighter(a)})`;const n=map(c);return`rgba(${Math.round(n.r)},${Math.round(n.g)},${Math.round(n.b)},${a})`;})
  .replace(/color-scheme:\s*dark/g,'color-scheme:light');
}
if(require.main===module)for(const f of process.argv.slice(2)){fs.writeFileSync(f,recolor(fs.readFileSync(f,'utf8')));console.log('recoloured',f);}
module.exports={recolor,map};
