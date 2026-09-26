'use strict';
// Browser smoke check of the built site against the local server (API in-process, local PostgreSQL).
// Usage: DATABASE_URL=… node scripts/server.cjs & node tests/browser/smoke-v3.cjs [baseUrl] [outDir]
const {chromium}=require('playwright-core'),fs=require('node:fs'),path=require('node:path');
const base=process.argv[2]||'http://127.0.0.1:4173',out=process.argv[3]||'/tmp/rebound-smoke';
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM||'/opt/pw-browsers/chromium/chrome-linux/chrome'});
 const results=[];
 for(const [label,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]]){
  const page=await browser.newPage({viewport});const errors=[];
  page.on('pageerror',e=>errors.push('pageerror: '+e.message));page.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource|dexscreener|tradingview|ERR_/.test(m.text()))errors.push('console: '+m.text());});
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.fill('#rebound-entry-password','1111');await page.click('#rebound-entry-form button');
  for(const route of ['explore','launch','portfolio','analytics','docs','token/9DLdFf1x8q2Vfpfp1ZkKbtVoyL9xSbBGSRCxuJSXiDSF','admin']){
   await page.evaluate(r=>{location.hash='#'+r;},route);await page.waitForTimeout(1500);
   const text=await page.evaluate(()=>document.querySelector('#main').innerText);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
   await page.screenshot({path:path.join(out,`${label}-${route.split('/')[0]}.png`),fullPage:false});
   results.push({label,route:route.split('/')[0],chars:text.length,overflow,snippet:text.replace(/\s+/g,' ').slice(0,140)});
  }
  results.push({label,errors});await page.close();
 }
 await browser.close();console.log(JSON.stringify(results,null,1));
})().catch(e=>{console.error(e);process.exit(1);});
