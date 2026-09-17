'use strict';
const {getStore}=require('@netlify/blobs'),P=require('./policy.cjs'),W=require('./wire.cjs');
const store=()=>getStore({name:'rebound-token-metadata',consistency:'strong'});
async function upload({origin,name,symbol,description,imageBase64}){
 if(typeof name!=='string'||Buffer.byteLength(name)>32||!name.trim()||typeof symbol!=='string'||Buffer.byteLength(symbol)>10||!symbol.trim()||typeof description!=='string'||description.length>2000)throw Error('Invalid token metadata');
 const bytes=Buffer.from(imageBase64||'','base64');if(bytes.length>2000000||bytes.length<16)throw Error('Choose a PNG or JPEG image smaller than 2 MB.');
 const mime=bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':null;if(!mime)throw Error('PNG and JPEG images only.');
 const imageHash=W.hash(bytes).toString('hex'),image=origin+'/.netlify/functions/rewards?action=image&hash='+imageHash;
 await store().set(imageHash,bytes,{metadata:{mime}});
 const data={name:name.trim(),symbol:symbol.trim(),description,image},text=P.stable(data),hash=W.hash(text).toString('hex');await store().set(hash,text,{metadata:{mime:'application/json'}});
 return{hash,uri:origin+'/.netlify/functions/rewards?action=metadata&hash='+hash,data};
}
async function read(hash){if(!/^[a-f0-9]{64}$/.test(hash||''))throw Error('Invalid content hash');return store().getWithMetadata(hash,{type:'arrayBuffer'});}
module.exports={upload,read};
