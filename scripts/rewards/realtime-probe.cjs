'use strict';
// Operator probe: subscribe anonymously (publishable key only) to the public token projection
// and report the first change received. Used to verify Realtime + RLS on a live project.
// Usage: SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… node scripts/rewards/realtime-probe.cjs [seconds]
const {createClient}=require('@supabase/supabase-js');
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_PUBLISHABLE_KEY,seconds=Number(process.argv[2]||60);
if(!url||!key){console.error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required');process.exit(2);}
// Behind an egress proxy (CI/containers) Node's built-in WebSocket ignores HTTPS_PROXY.
function transport(){
 if(!process.env.HTTPS_PROXY)return undefined;
 const WS=require('ws'),{HttpsProxyAgent}=require('https-proxy-agent'),agent=new HttpsProxyAgent(process.env.HTTPS_PROXY);
 return class extends WS{constructor(address,protocols){super(address,protocols,{agent});}};
}
const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},realtime:{transport:transport()}});
const started=Date.now();
const channel=client.channel('probe-public-tokens').on('postgres_changes',{event:'*',schema:'rebound',table:'reward_public_tokens'},payload=>{
 console.log(JSON.stringify({received:true,event:payload.eventType,mint:payload.new?.mint||payload.old?.mint,revision:payload.new?.revision,latencyMs:payload.commit_timestamp?Date.now()-Date.parse(payload.commit_timestamp):null}));
 if(payload.eventType==='INSERT'){client.removeChannel(channel).then(()=>process.exit(0));}
}).subscribe((status,err)=>{console.log(JSON.stringify({status,error:err?.message||null,afterMs:Date.now()-started}));});
setTimeout(()=>{console.log(JSON.stringify({received:false,timeoutSeconds:seconds}));process.exit(1);},seconds*1000);
