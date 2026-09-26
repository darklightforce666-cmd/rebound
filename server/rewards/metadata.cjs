'use strict';
// Token metadata and images. New uploads go to Supabase Storage (immutable, content hashed,
// stable public URL suitable for permanent on-chain metadata). Existing Netlify Blobs
// objects remain readable through the compatibility endpoint so published URIs never break.
const P=require('./policy.cjs'),W=require('./wire.cjs'),S=require('./storage.cjs');

const LIMITS=Object.freeze({nameBytes:32,symbolBytes:10,descriptionChars:2000,imageBytes:2000000,uriChars:200,linkChars:200});
function sniff(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return{mime:'image/png',ext:'png'};
 if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return{mime:'image/jpeg',ext:'jpg'};
 return null;
}
function link(value,hosts){
 if(value==null||value==='')return undefined;
 if(typeof value!=='string'||value.length>LIMITS.linkChars)throw Error('Invalid social link');
 let u;try{u=new URL(value);}catch{throw Error('Invalid social link');}
 if(u.protocol!=='https:'||u.username||u.password||(hosts&&!hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))))throw Error('Invalid social link');
 return u.toString();
}
// Validate and normalize the creator's input. Throws a user-safe message on failure.
function validate({name,symbol,description='',imageBase64,twitter,telegram,website}){
 if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name.trim())>LIMITS.nameBytes)throw Error('Name must be 1–32 bytes.');
 if(typeof symbol!=='string'||!/^[A-Za-z0-9$._-]+$/.test(symbol.trim())||Buffer.byteLength(symbol.trim())>LIMITS.symbolBytes)throw Error('Ticker must be 1–10 letters or digits.');
 if(typeof description!=='string'||description.length>LIMITS.descriptionChars)throw Error('Description must be at most 2000 characters.');
 const bytes=Buffer.from(typeof imageBase64==='string'?imageBase64:'','base64');
 if(bytes.length<16||bytes.length>LIMITS.imageBytes)throw Error('Choose a PNG or JPEG image smaller than 2 MB.');
 const type=sniff(bytes);if(!type)throw Error('PNG and JPEG images only.');
 return{name:name.trim(),symbol:symbol.trim(),description,bytes,type,
  links:{twitter:link(twitter,['x.com','twitter.com']),telegram:link(telegram,['t.me','telegram.me']),website:link(website)}};
}
async function upload(db,{cfg=S.storageConfig(),createdBy,origin,...input},fetchImpl=fetch){
 const v=validate(input);
 const imageHash=W.hash(v.bytes).toString('hex'),imagePath=`images/${imageHash}.${v.type.ext}`;
 await S.put(cfg,S.BUCKETS.assets,imagePath,v.bytes,v.type.mime,fetchImpl);
 const image=S.publicUrl(cfg,S.BUCKETS.assets,imagePath);
 await S.record(db,{hash:imageHash,kind:'image',bucket:S.BUCKETS.assets,path:imagePath,mime:v.type.mime,bytes:v.bytes.length,publicUrl:image,createdBy});
 const data={name:v.name,symbol:v.symbol,description:v.description,image,showName:true,createdOn:origin||'https://rebound.wtf',...Object.fromEntries(Object.entries(v.links).filter(([,x])=>x))};
 const text=P.stable(data),bytes=Buffer.from(text),hash=W.hash(bytes).toString('hex'),path=`metadata/${hash}.json`;
 await S.put(cfg,S.BUCKETS.assets,path,bytes,'application/json',fetchImpl);
 const uri=S.publicUrl(cfg,S.BUCKETS.assets,path);if(uri.length>LIMITS.uriChars)throw Error('Metadata URI too long');
 await S.record(db,{hash,kind:'metadata',bucket:S.BUCKETS.assets,path,mime:'application/json',bytes:bytes.length,publicUrl:uri,createdBy});
 return{hash,uri,image,data};
}
// Resolve stored metadata JSON by content hash (Supabase first, then legacy Blobs).
async function readMetadata(db,hash,{cfg=S.storageConfig(),fetchImpl=fetch}={}){
 if(!/^[a-f0-9]{64}$/.test(hash||''))throw Error('Invalid content hash');
 const row=(await db.query("SELECT bucket,path,public_url FROM reward_assets WHERE hash=$1 AND kind='metadata'",[hash])).rows[0];
 if(row){const bytes=await S.get(cfg,row.bucket,row.path,fetchImpl);if(bytes&&W.hash(bytes).toString('hex')===hash)return{uri:row.public_url,data:JSON.parse(bytes)};throw Error('Stored metadata unavailable');}
 const legacy=await readLegacy(hash);if(!legacy||legacy.metadata?.mime!=='application/json')return null;
 const bytes=Buffer.from(legacy.data);if(W.hash(bytes).toString('hex')!==hash)throw Error('Content hash mismatch');
 return{uri:null,data:JSON.parse(bytes),legacy:true};
}
// Compatibility: V2 URIs /.netlify/functions/rewards?action=metadata|image&hash=… (Netlify Blobs).
async function readLegacy(hash){
 if(!/^[a-f0-9]{64}$/.test(hash||''))throw Error('Invalid content hash');
 const {getStore}=require('@netlify/blobs');return getStore({name:'rebound-token-metadata',consistency:'strong'}).getWithMetadata(hash,{type:'arrayBuffer'});
}
module.exports={LIMITS,sniff,validate,upload,readMetadata,readLegacy,read:readLegacy};
