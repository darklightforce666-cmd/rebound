'use strict';
// SOL/USD evidence (spec §7.4). Source: Pyth SOL/USD, feed id configured in the policy.
// Two providers, one validation path:
//  * 'pyth-hermes'  — Pyth Hermes/Benchmarks REST (historical by timestamp). Since
//                     2026-08-26 an API key is required (Authorization: Bearer PYTH_API_KEY).
//  * 'pyth-onchain' — the Pyth PriceUpdateV2 account on Solana read at finalized commitment
//                     (live sampling by the worker; no API key).
// Every observation is validated for feed id, verification level, age and confidence.
// A missing/invalid price returns null — callers HOLD; a missing price is never zero.
const W=require('./wire.cjs'),P3=require('./policy-v3.cjs'),{stable}=require('./policy.cjs');
const FEED=P3.POLICY.solUsd.feedId.replace(/^0x/,'');
const RECEIVER='rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';           // Pyth Solana Receiver (PriceUpdateV2 owner)
const PUSH_ORACLE='pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT';         // Pyth push-feed program
const PRICE_UPDATE_V2_DISC=W.hash('account:PriceUpdateV2').subarray(0,8);

// price × 10^expo USD → usd_pico (floor). Negative prices are invalid for SOL/USD.
function toPico(price,expo){
 const p=BigInt(price),e=Number(expo);if(p<=0n||!Number.isInteger(e)||e<-30||e>30)return null;
 const shift=12+e;return shift>=0?p*10n**BigInt(shift):p/10n**BigInt(-shift);
}
function observation({price,conf,expo,publishTime,source,evidence}){
 const pp=toPico(price,expo),cp=BigInt(conf)>=0n?(()=>{const s=12+Number(expo);return s>=0?BigInt(conf)*10n**BigInt(s):BigInt(conf)/10n**BigInt(-s);})():null;
 if(pp==null||cp==null||!Number.isSafeInteger(Number(publishTime)))return null;
 return{time:Number(publishTime),price:pp,conf:cp,source,evidence};
}
// Validate an observation for use at time `at` (unix seconds).
function valid(o,at,policy=P3.POLICY){
 if(!o)return{ok:false,reason:'sol_usd_unavailable'};
 if(o.time>at)return{ok:false,reason:'sol_usd_after_time'};
 if(at-o.time>policy.solUsd.maxAgeSeconds)return{ok:false,reason:'sol_usd_stale'};
 if(o.conf*10000n>o.price*BigInt(policy.solUsd.maxConfidenceBps))return{ok:false,reason:'sol_usd_confidence'};
 return{ok:true};
}

// ---------- Pyth Hermes / Benchmarks (API key) ----------
function hermesConfig(env=process.env){
 return{hermes:(env.PYTH_HERMES_URL||'https://pyth.dourolabs.app/hermes').replace(/\/+$/,''),benchmarks:(env.PYTH_BENCHMARKS_URL||'https://benchmarks.pyth.network').replace(/\/+$/,''),key:env.PYTH_API_KEY||'',configured:!!env.PYTH_API_KEY};
}
function parseHermes(json,source){
 const rows=json?.parsed;if(!Array.isArray(rows))return[];
 return rows.filter(r=>String(r.id).replace(/^0x/,'')===FEED&&r.price).map(r=>observation({price:r.price.price,conf:r.price.conf,expo:r.price.expo,publishTime:r.price.publish_time,source,evidence:{feed:FEED,publishTime:r.price.publish_time,binaryDigest:json.binary?.data?W.hash(JSON.stringify(json.binary.data)).toString('hex'):null}})).filter(Boolean);
}
// Updates published in [t - window, t] (window ≤ 60 s per Benchmarks), newest last.
async function hermesAt(t,{window=30,cfg=hermesConfig(),fetchImpl=fetch}={}){
 if(!cfg.configured)throw Object.assign(Error('PYTH_API_KEY is not configured'),{code:'SOL_USD_SOURCE_UNCONFIGURED'});
 const url=`${cfg.benchmarks}/v1/updates/price/${Math.floor(t-window)}/${window}?ids=0x${FEED}&parsed=true`;
 const r=await fetchImpl(url,{headers:{authorization:'Bearer '+cfg.key,accept:'application/json'},signal:AbortSignal.timeout(15000)});
 if(r.status===401||r.status===403)throw Object.assign(Error('Pyth API key rejected'),{code:'SOL_USD_SOURCE_UNAUTHORIZED'});
 if(!r.ok)throw Object.assign(Error('Pyth benchmarks unavailable'),{code:'SOL_USD_SOURCE_UNAVAILABLE'});
 const body=await r.json(),list=Array.isArray(body)?body.flatMap(b=>parseHermes(b,'pyth-benchmarks')):parseHermes(body,'pyth-benchmarks');
 return list.filter(o=>o.time<=t).sort((a,b)=>a.time-b.time);
}

// Latest update from Hermes (fresh to ~1 s; the on-chain sponsored feed is only ~every 53 s, which is
// longer than the policy's 30 s maximum age). Same key as Benchmarks.
async function hermesLatest({cfg=hermesConfig(),fetchImpl=fetch}={}){
 if(!cfg.configured)return null;
 const r=await fetchImpl(`${cfg.hermes}/v2/updates/price/latest?ids[]=0x${FEED}&parsed=true`,{headers:{authorization:'Bearer '+cfg.key,accept:'application/json'},signal:AbortSignal.timeout(10000)});
 if(r.status===401||r.status===403)throw Object.assign(Error('Pyth API key rejected'),{code:'SOL_USD_SOURCE_UNAUTHORIZED'});
 if(!r.ok)throw Object.assign(Error('Pyth Hermes unavailable'),{code:'SOL_USD_SOURCE_UNAVAILABLE'});
 return parseHermes(await r.json(),'pyth-hermes').sort((a,b)=>b.time-a.time)[0]||null;
}

// ---------- Pyth on-chain PriceUpdateV2 ----------
// Layout (Anchor): disc[8] write_authority[32] verification_level{0:Partial(u8),1:Full}
// price_message{feed_id[32] price i64 conf u64 exponent i32 publish_time i64 prev_publish_time i64
// ema_price i64 ema_conf u64} posted_slot u64
function decodePriceUpdateV2(data){
 const b=Buffer.from(data);if(b.length<8+32+1||!b.subarray(0,8).equals(PRICE_UPDATE_V2_DISC))return null;
 let o=40;const level=b[o++];let signatures=null;if(level===0)signatures=b[o++];else if(level!==1)return null;
 const feed=b.subarray(o,o+32).toString('hex');o+=32;
 const price=b.readBigInt64LE(o);o+=8;const conf=b.readBigUInt64LE(o);o+=8;const expo=b.readInt32LE(o);o+=4;const publishTime=b.readBigInt64LE(o);o+=8;
 o+=8+8+8;const postedSlot=b.length>=o+8?b.readBigUInt64LE(o):null;
 return{full:level===1,signatures,feed,price,conf,expo,publishTime:Number(publishTime),postedSlot};
}
async function onchainAt(connection,account,{commitment='finalized'}={}){
 const r=await connection.getAccountInfoAndContext(W.pk(account),commitment);
 const info=r.value;if(!info||info.owner.toBase58()!==RECEIVER&&info.owner.toBase58()!==PUSH_ORACLE)return null;
 const d=decodePriceUpdateV2(info.data);if(!d||!d.full||d.feed!==FEED)return null;
 return observation({price:d.price,conf:d.conf,expo:d.expo,publishTime:d.publishTime,source:'pyth-onchain',evidence:{account,slot:r.context.slot,postedSlot:d.postedSlot!=null?String(d.postedSlot):null,owner:info.owner.toBase58()}});
}

// ---------- persistence and lookup ----------
async function persist(db,o){
 if(!o)return;
 await db.query('INSERT INTO reward_sol_usd(feed_id,publish_time,price_usd_pico,conf_usd_pico,source,evidence) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[FEED,o.time,String(o.price),String(o.conf),o.source,stable(o.evidence||{})]);
}
async function load(db,from,to){
 return(await db.query('SELECT publish_time,price_usd_pico,conf_usd_pico,source FROM reward_sol_usd WHERE feed_id=$1 AND publish_time BETWEEN $2 AND $3 ORDER BY publish_time',[FEED,from,to])).rows.map(r=>({time:Number(r.publish_time),price:BigInt(r.price_usd_pico),conf:BigInt(r.conf_usd_pico),source:r.source}));
}
// fx(time): the latest valid observation at or before `time` from a preloaded sorted series.
function lookup(series,policy=P3.POLICY){
 const s=[...series].sort((a,b)=>a.time-b.time);
 return time=>{let lo=0,hi=s.length-1,best=null;while(lo<=hi){const m=(lo+hi)>>1;if(s[m].time<=time){best=s[m];lo=m+1;}else hi=m-1;}return best&&valid(best,time,policy).ok?best:null;};
}
module.exports={FEED,RECEIVER,PUSH_ORACLE,toPico,observation,valid,hermesConfig,parseHermes,hermesAt,hermesLatest,decodePriceUpdateV2,onchainAt,persist,load,lookup};

// ---------- on-chain history (free): Pyth push-oracle update transactions ----------
// A successful `update_price_feed` transaction proves the receiver verified the Merkle price
// message against a Wormhole-verified root. Its instruction data carries the message:
// disc[8] | message: u32 len + bytes | proof: u32 n + n×[20] | treasury_id u8 | shard_id u16 | feed_id[32]
// PriceFeedMessage (big-endian): type u8 (0) | feed_id[32] | price i64 | conf u64 | exponent i32 |
// publish_time i64 | prev_publish_time i64 | ema_price i64 | ema_conf u64
const UPDATE_DISC=W.hash('global:update_price_feed').subarray(0,8);
function decodePushUpdate(data){
 const b=Buffer.from(data);if(b.length<8+4||!b.subarray(0,8).equals(UPDATE_DISC))return null;
 let o=8;const len=b.readUInt32LE(o);o+=4;if(o+len>b.length)return null;const m=b.subarray(o,o+len);
 if(m.length<1+32+8+8+4+8||m[0]!==0)return null;
 return{feed:m.subarray(1,33).toString('hex'),price:m.readBigInt64BE(33),conf:m.readBigUInt64BE(41),expo:m.readInt32BE(49),publishTime:Number(m.readBigInt64BE(53))};
}
// Extract SOL/USD observations from a finalized, successful transaction (jsonParsed or json).
function fromUpdateTransaction(tx,{feedAccount}={}){
 if(!tx||tx.meta?.err)return[];const bs58=require('bs58');
 const keys=tx.transaction.message.accountKeys.map(k=>typeof k==='string'?k:k.pubkey);
 const all=[...tx.transaction.message.instructions,...(tx.meta?.innerInstructions||[]).flatMap(i=>i.instructions)];
 const out=[];for(const ins of all){
  const program=ins.programId||keys[ins.programIdIndex];if(program!==PUSH_ORACLE||!ins.data)continue;
  const accounts=(ins.accounts||[]).map(a=>typeof a==='number'?keys[a]:a);if(feedAccount&&!accounts.includes(feedAccount))continue;
  const d=decodePushUpdate(bs58.decode(ins.data));if(!d||d.feed!==FEED)continue;
  const o=observation({price:d.price,conf:d.conf,expo:d.expo,publishTime:d.publishTime,source:'pyth-onchain-history',evidence:{signature:tx.transaction.signatures[0],slot:tx.slot}});if(o)out.push(o);
 }return out;
}
Object.assign(module.exports,{UPDATE_DISC,decodePushUpdate,fromUpdateTransaction});

// SOL/USD at the given unix times from the on-chain feed's update history (no API key).
// Pages the feed account's finalized signatures (which carry blockTime) back to the earliest
// requested time, then fetches only the update transaction nearest each time.
const DEFAULT_FEED_ACCOUNT='7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
async function onchainHistory(rpc,times,{account=process.env.PYTH_SOL_USD_ACCOUNT||DEFAULT_FEED_ACCOUNT,maxPages=400}={}){
 const want=[...new Set(times.map(Number))].sort((a,b)=>a-b);if(!want.length)return[];
 const earliest=want[0]-60,sigs=[];let before;
 for(let p=0;p<maxPages;p++){
  const opts={limit:1000,commitment:'finalized'};if(before)opts.before=before;
  const page=await rpc.call('getSignaturesForAddress',[account,opts]);sigs.push(...page.filter(s=>!s.err));
  if(page.length<1000||(page.at(-1).blockTime!=null&&page.at(-1).blockTime<earliest))break;before=page.at(-1).signature;
 }
 sigs.sort((a,b)=>(a.blockTime||0)-(b.blockTime||0));
 const picked=new Map();
 for(const t of want){let best=null;for(const s of sigs){if(s.blockTime!=null&&s.blockTime<=t)best=s;else if(s.blockTime>t)break;}if(best)picked.set(best.signature,best);}
 const out=[];
 for(const s of picked.values()){
  const tx=await rpc.call('getTransaction',[s.signature,{encoding:'json',commitment:'finalized',maxSupportedTransactionVersion:1}]);
  out.push(...fromUpdateTransaction(tx,{feedAccount:account}));
 }
 return out.sort((a,b)=>a.time-b.time);
}
Object.assign(module.exports,{DEFAULT_FEED_ACCOUNT,onchainHistory});
