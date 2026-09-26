'use strict';
// Structured, redacted, persisted-first logs (spec §11.3). The row is committed to
// reward_logs; Supabase Realtime then notifies admins. A missed socket event loses nothing.
const {stable}=require('./policy.cjs');
const SEVERITIES=new Set(['debug','info','warn','error','critical']);
const SECRET_KEY=/secret|private|seed|mnemonic|password|passphrase|token|authorization|cookie|apikey|api_key|keypair|ciphertext|master/i;
const PATTERNS=[
 [/postgres(?:ql)?:\/\/[^\s"']+/gi,'[database-url]'],
 [/https?:\/\/[^\s"']*(?:api[-_]?key|token|secret|auth)=[^\s"'&]+[^\s"']*/gi,'[credential-url]'],
 [/https?:\/\/[^\s"'/]*(?:helius|quiknode|quicknode|alchemy|triton|rpcpool|ankr|syndica)[^\s"']*/gi,'[rpc-endpoint]'],
 [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,'[jwt]'],
 [/\bsb_secret_[A-Za-z0-9_-]+/g,'[supabase-secret]'],
 [/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g,'[pem]'],
 [/\[(?:\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g,'[byte-array]'],
 [/\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/g,'[base58-secret]'],
 [/^\s*(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\s*$/g,'[word-list]'],   // a bare mnemonic-shaped string
];
function redactText(value){let s=String(value??'');for(const[re,rep]of PATTERNS)s=s.replace(re,rep);return s.slice(0,2000);}
function redact(value,depth=0){
 if(depth>6)return'[depth]';
 if(value==null||typeof value==='boolean'||typeof value==='number')return value;
 if(typeof value==='bigint')return value.toString();
 if(typeof value==='string')return redactText(value);
 if(Buffer.isBuffer(value)||value instanceof Uint8Array)return'[bytes:'+value.length+']';
 if(Array.isArray(value))return value.slice(0,50).map(v=>redact(v,depth+1));
 if(typeof value==='object'){const out={};for(const[k,v]of Object.entries(value).slice(0,50))out[k]=SECRET_KEY.test(k)?'[redacted]':redact(v,depth+1);return out;}
 return String(value);
}
async function log(db,e){
 const severity=SEVERITIES.has(e.severity)?e.severity:'info';
 const row=[e.timestamp||new Date().toISOString(),severity,String(e.component||'unknown').slice(0,64),String(e.eventType||e.event_type||'event').slice(0,96),e.namespace||'production',
  e.mint||null,e.cycleId||null,e.jobId||null,e.requestId||null,redactText(e.message||''),e.errorCode||null,Number.isSafeInteger(e.retryCount)?e.retryCount:0,
  e.signature&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(e.signature)?e.signature:null,e.slot!=null?String(e.slot):null,stable(redact(e.metadata||{}))];
 const r=await db.query('INSERT INTO reward_logs(timestamp_utc,severity,component,event_type,namespace,mint,cycle_id,job_id,request_id,safe_message,error_code,retry_count,transaction_signature,finalized_slot,safe_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id',row);
 return r.rows[0].id;
}
async function heartbeat(db,component,status,detail={}){
 await db.query('INSERT INTO reward_health(component,status,detail,heartbeat_at) VALUES($1,$2,$3,now()) ON CONFLICT(component) DO UPDATE SET status=EXCLUDED.status,detail=EXCLUDED.detail,heartbeat_at=now()',[component,status,stable(redact(detail))]);
}
module.exports={redact,redactText,log,heartbeat};
