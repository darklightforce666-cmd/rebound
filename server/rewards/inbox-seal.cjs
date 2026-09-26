'use strict';
// Sealed key transfer from the admin's browser to the settlement worker (WebCrypto only, so the
// browser bundle and the worker share this exact code).
//   X25519(ephemeral, worker inbox key) → HKDF-SHA256(salt = eph‖worker, info = "rebound-key-inbox-v1")
//   → AES-256-GCM(iv 12 B, AAD = binding string).
// The API only ever sees {ephemeral, iv, ciphertext}; without the worker's private inbox key (a file on
// the worker host) they are useless. The AAD binds the ciphertext to one funding wallet row, its address
// and the worker key it was sealed to, so it cannot be replayed against another wallet.
const subtle=()=>{const s=globalThis.crypto?.subtle;if(!s)throw Error('WebCrypto is not available');return s;};
const INFO='rebound-key-inbox-v1';
const enc=s=>new TextEncoder().encode(s);
const b64u={
 encode:bytes=>{let s='';for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');},
 decode:str=>{const s=String(str).replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(s+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));},
};
const binding=({fundingWallet,address,inboxPublicKey})=>`rebound-key-inbox:v1:${fundingWallet}:${address}:${inboxPublicKey}`;
async function aesKey(shared,ephRaw,workerRaw,usage){
 const hk=await subtle().importKey('raw',shared,'HKDF',false,['deriveKey']);
 const salt=new Uint8Array(ephRaw.length+workerRaw.length);salt.set(ephRaw);salt.set(workerRaw,ephRaw.length);
 return subtle().deriveKey({name:'HKDF',hash:'SHA-256',salt,info:enc(INFO)},hk,{name:'AES-GCM',length:256},false,[usage]);
}
/** Browser side: seal `secret` (Uint8Array) to the worker's inbox public key (base64url raw X25519). */
async function seal(secret,{fundingWallet,address,inboxPublicKey}){
 const workerRaw=b64u.decode(inboxPublicKey);if(workerRaw.length!==32)throw Error('Invalid worker key');
 const eph=await subtle().generateKey({name:'X25519'},true,['deriveBits']);
 const pub=await subtle().importKey('raw',workerRaw,{name:'X25519'},false,[]);
 const shared=new Uint8Array(await subtle().deriveBits({name:'X25519',public:pub},eph.privateKey,256));
 const ephRaw=new Uint8Array(await subtle().exportKey('raw',eph.publicKey));
 const key=await aesKey(shared,ephRaw,workerRaw,'encrypt');shared.fill(0);
 const iv=globalThis.crypto.getRandomValues(new Uint8Array(12));
 const ct=new Uint8Array(await subtle().encrypt({name:'AES-GCM',iv,additionalData:enc(binding({fundingWallet,address,inboxPublicKey}))},key,secret));
 return{ephemeralPublicKey:b64u.encode(ephRaw),iv:b64u.encode(iv),ciphertext:b64u.encode(ct)};
}
/** Worker side: open with the private inbox key (JWK {kty:'OKP',crv:'X25519',d,x}). Returns Uint8Array. */
async function open(sealed,jwk,{fundingWallet,address}){
 const priv=await subtle().importKey('jwk',{kty:'OKP',crv:'X25519',d:jwk.d,x:jwk.x},{name:'X25519'},false,['deriveBits']);
 const ephRaw=b64u.decode(sealed.ephemeralPublicKey),workerRaw=b64u.decode(jwk.x);
 const pub=await subtle().importKey('raw',ephRaw,{name:'X25519'},false,[]);
 const shared=new Uint8Array(await subtle().deriveBits({name:'X25519',public:pub},priv,256));
 const key=await aesKey(shared,ephRaw,workerRaw,'decrypt');shared.fill(0);
 return new Uint8Array(await subtle().decrypt({name:'AES-GCM',iv:b64u.decode(sealed.iv),additionalData:enc(binding({fundingWallet,address,inboxPublicKey:jwk.x}))},key,b64u.decode(sealed.ciphertext)));
}
/** New inbox key pair as a private JWK (the public part is jwk.x). */
async function generate(){
 const kp=await subtle().generateKey({name:'X25519'},true,['deriveBits']);
 const j=await subtle().exportKey('jwk',kp.privateKey);return{kty:'OKP',crv:'X25519',d:j.d,x:j.x};
}
module.exports={seal,open,generate,binding,b64u,INFO};
