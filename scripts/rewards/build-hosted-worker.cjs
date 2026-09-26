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
 `globalThis.process??=__mods.process.default;globalThis.Buffer??=__mods.buffer.Buffer;globalThis.global??=globalThis;`;
require('esbuild').buildSync({entryPoints:[path.join(dir,'entry.mjs')],bundle:true,platform:'node',format:'esm',target:'es2022',minify:true,legalComments:'none',
 outfile:path.join(dir,'worker-bundle.mjs'),external:['pg-native'],banner:{js:banner},footer:{js:''},logLevel:'warning',define:{'process.env.NODE_ENV':'"production"'}});
const out=path.join(dir,'worker-bundle.mjs');
console.log('hosted worker bundle:',(fs.statSync(out).size/1024|0)+' KB');
