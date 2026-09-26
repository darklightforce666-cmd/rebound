'use strict';
// Supabase Storage client for the server (spec §15). Content-addressed, immutable objects:
// path = <kind>/<sha256>.<ext>, uploaded with x-upsert:false. An existing object is accepted
// only if its bytes hash to the same name. Browsers have no Storage write policy.
// The secret key is read from the server environment only and never logged or returned.
const W=require('./wire.cjs');
const BUCKETS=Object.freeze({assets:'rebound-token-assets',evidence:'rebound-evidence'});

function storageConfig(env=process.env){
 const url=(env.SUPABASE_URL||'').replace(/\/+$/,''),key=env.SUPABASE_SECRET_KEY||'';
 return{url,key,configured:/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)&&/^sb_secret_/.test(key)};
}
const publicUrl=(cfg,bucket,path)=>`${cfg.url}/storage/v1/object/public/${bucket}/${path}`;

async function put(cfg,bucket,path,bytes,mime,fetchImpl=fetch){
 if(!cfg.configured)throw Object.assign(Error('File storage is not configured yet.'),{code:'STORAGE_UNAVAILABLE'});
 const endpoint=`${cfg.url}/storage/v1/object/${bucket}/${path}`;
 const response=await fetchImpl(endpoint,{method:'POST',headers:{apikey:cfg.key,authorization:'Bearer '+cfg.key,'content-type':mime,'x-upsert':'false','cache-control':'31536000'},body:bytes,signal:AbortSignal.timeout(20000)});
 if(response.ok)return{created:true};
 // Already present: verify immutability by content hash instead of overwriting.
 if(response.status===409||response.status===400){
  const existing=await get(cfg,bucket,path,fetchImpl);
  if(existing&&W.hash(existing).equals(W.hash(bytes)))return{created:false};
  throw Object.assign(Error('Stored object conflict'),{code:'STORAGE_CONFLICT'});
 }
 throw Object.assign(Error('File storage is temporarily unavailable.'),{code:'STORAGE_UNAVAILABLE'});
}
async function get(cfg,bucket,path,fetchImpl=fetch){
 const url=bucket===BUCKETS.assets?publicUrl(cfg,bucket,path):`${cfg.url}/storage/v1/object/authenticated/${bucket}/${path}`;
 const headers=bucket===BUCKETS.assets?{}:{apikey:cfg.key,authorization:'Bearer '+cfg.key};
 const r=await fetchImpl(url,{headers,signal:AbortSignal.timeout(15000)});if(r.status===404||r.status===400)return null;if(!r.ok)throw Error('Storage read failed');
 return Buffer.from(await r.arrayBuffer());
}
// Record every stored object; the row is immutable (trigger).
async function record(db,{hash,kind,bucket,path,mime,bytes,publicUrl:url,createdBy}){
 await db.query('INSERT INTO reward_assets(hash,kind,bucket,path,mime,bytes,public_url,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(hash) DO NOTHING',[hash,kind,bucket,path,mime,bytes,url||null,createdBy||null]);
}
module.exports={BUCKETS,storageConfig,publicUrl,put,get,record};
