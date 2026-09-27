#!/usr/bin/env node
'use strict';
// Bundle the hosted worker (Supabase Edge Function, Deno) into one ES module with Node built-ins mapped
// to Deno's node: modules. Output: supabase/functions/rebound-worker/worker-bundle.mjs
const path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'supabase/functions/rebound-worker');
const MODS=['util/types','buffer','crypto','util','stream','events','fs','fs/promises','path','http','https','url','net','tls','zlib','punycode','process','string_decoder','os','dns','module','assert','querystring','timers','worker_threads','child_process'];
const id=m=>'__n_'+m.replace(/\W/g,'_');
const banner=MODS.map(m=>`import * as ${id(m)} from 'node:${m}';`).join('')+
 `const __mods={${MODS.map(m=>JSON.stringify(m)+':'+id(m)).join(',')}};`+
 `const require=(n)=>{const m=__mods[String(n).replace(/^node:/,'')];if(!m)throw new Error('Module not available in the hosted worker: '+n);return m.default??m;};`+
 `globalThis.process??=__mods.process.default;globalThis.Buffer??=__mods.buffer.Buffer;globalThis.global??=globalThis;`+
 // Supabase Edge forbids writing the real environment (Deno.env.set): the bundle sees a process whose env
 // is a private, writable copy (module-scoped, so it shadows the global for every bundled module).
 `const __realProcess=globalThis.process;const __env=(()=>{try{return typeof Deno!=='undefined'?Deno.env.toObject():{...__realProcess.env};}catch{return {};}})();`+
 `const process=new Proxy(__realProcess,{get(t,k){if(k==='env')return __env;const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});`;
require('esbuild').buildSync({entryPoints:[path.join(dir,'entry.mjs')],bundle:true,platform:'node',format:'esm',target:'es2022',minify:true,keepNames:true,legalComments:'none',
 outfile:path.join(dir,'worker-bundle.mjs'),external:['pg-native'],banner:{js:banner},footer:{js:''},logLevel:'warning',define:{'process.env.NODE_ENV':'"production"'}});
const out=path.join(dir,'worker-bundle.mjs');
console.log('hosted worker bundle:',(fs.statSync(out).size/1024|0)+' KB');
