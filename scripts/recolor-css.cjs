'use strict';
// One-off migration (kept for the record): maps the legacy greyscale/emerald palette onto the
// "Proof in motion" palette. Neutral colours follow their lightness onto a green-tinted ramp;
// saturated greens become mint, warm colours amber, blues the waterline teal. Alpha is kept.
const fs=require('node:fs');
const hex=h=>{h=h.slice(1);if(h.length<=4)h=[...h].map(c=>c+c).join('');return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16),a:h.length===8?h.slice(6,8):''};};
const toHex=({r,g,b})=>'#'+[r,g,b].map(v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('').toUpperCase();
const mix=(a,b,t)=>({r:a.r+(b.r-a.r)*t,g:a.g+(b.g-a.g)*t,b:a.b+(b.b-a.b)*t});
function hsl({r,g,b}){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2,d=mx-mn;
 if(!d)return{h:0,s:0,l};const s=d/(1-Math.abs(2*l-1));let h=mx===r?((g-b)/d)%6:mx===g?(b-r)/d+2:(r-g)/d+4;return{h:(h*60+360)%360,s,l};}
const ramp=(stops,x)=>{for(let i=1;i<stops.length;i++)if(x<=stops[i][0]){const [x0,c0]=stops[i-1],[x1,c1]=stops[i];return mix(hex(c0),hex(c1),(x-x0)/(x1-x0||1));}return hex(stops.at(-1)[1]);};
// Palette v2 (canvas revision 2026-09-27 21:00): deep green water, cream ink, lime payouts, orange burn, aqua waterline.
const NEUTRAL=[[0,'#03110C'],[.055,'#06231B'],[.085,'#0A2A21'],[.115,'#0E3127'],[.16,'#15392E'],[.2,'#1B4135'],[.28,'#2A5244'],[.45,'#8FAD9F'],[.62,'#A9C2B6'],[.8,'#D8DDD0'],[.95,'#F4EFE3'],[1,'#FBF8F1']];
const MINT=[[0,'#06231B'],[.12,'#0F3529'],[.25,'#1E7A56'],[.55,'#D4F46A'],[.8,'#E6FAA8'],[1,'#F7FFE0']];
const AMBER=[[0,'#1A0A04'],[.15,'#3A1D10'],[.55,'#FF7A45'],[.8,'#FFB08F'],[1,'#FFF0E8']];
const TEAL=[[0,'#03161A'],[.15,'#0B2B30'],[.5,'#7FD8E6'],[.8,'#C2EEF5'],[1,'#F0FCFE']];
function map(c){const x=hsl(c);
 if(x.s<.28||(x.l<.18&&x.s<.45))return ramp(NEUTRAL,x.l);
 if(x.h>=70&&x.h<185)return ramp(MINT,x.l);
 if(x.h>=185&&x.h<270)return ramp(TEAL,x.l);
 return ramp(AMBER,x.l);}
function recolor(css){
 return css.replace(/#[0-9a-fA-F]{3,8}\b/g,m=>{if(![4,5,7,9].includes(m.length))return m;const c=hex(m);return toHex(map(c))+(c.a?c.a.toUpperCase():'');})
  .replace(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/g,(m,r,g,b,a)=>{const n=map({r:+r,g:+g,b:+b});return`rgba(${Math.round(n.r)},${Math.round(n.g)},${Math.round(n.b)},${a})`;});
}
if(require.main===module)for(const f of process.argv.slice(2)){fs.writeFileSync(f,recolor(fs.readFileSync(f,'utf8')));console.log('recoloured',f);}
module.exports={recolor,map};
