#!/usr/bin/env node
'use strict';
// READ-ONLY V3 preview for one mint at one cutoff (spec §11.1 "Calculate preview", M2 acceptance).
// No signing, no transactions, no database writes. Output: an auditable JSON report with the
// snapshot hash, coverage, exact per-holder outcomes/reasons and the proposed awards — or the
// named reason why no snapshot can be produced yet.
//
// Usage:
//   SOLANA_RPC_URL=https://… node scripts/rewards/preview-v3.cjs --mint <MINT> \
//     [--cutoff <unix seconds>|latest] [--reserve <lamports>] [--out report.json] [--rps 8]
// SOL/USD: PYTH_API_KEY (Pyth Benchmarks) if set, otherwise the on-chain Pyth feed history.
const fs=require('node:fs');
const H=require('../../server/rewards/history-v3.cjs'),S=require('../../server/rewards/snapshot-v3.cjs'),M=require('../../server/rewards/mint-v3.cjs');
const FX=require('../../server/rewards/sol-usd.cjs'),P3=require('../../server/rewards/policy-v3.cjs'),{stable}=require('../../server/rewards/policy.cjs');
const arg=(name,def)=>{const i=process.argv.indexOf('--'+name);return i>0?process.argv[i+1]:def;};

async function main(){
 const mint=arg('mint'),rpcUrl=arg('rpc',process.env.SOLANA_RPC_URL),out=arg('out',null),rps=Number(arg('rps','8'));
 if(!mint||!rpcUrl)throw Error('Usage: --mint <MINT> and SOLANA_RPC_URL (or --rpc) are required');
 const rpc=new H.Rpc(rpcUrl,{minIntervalMs:Math.ceil(1000/rps)}),started=Date.now(),report={generatedAt:new Date().toISOString(),mode:'read_only_preview',mint,policy:P3.POLICY.version,policyHash:P3.POLICY_HASH,blockers:[]};
 const log=m=>process.stderr.write(`[preview] ${m}\n`);
 report.mintInfo=await M.fetchMint(rpc,mint);
 if(!report.mintInfo.ok){report.blockers.push({reason:report.mintInfo.reason,detail:report.mintInfo.blockers||report.mintInfo.detail});return finish(report,out);}
 log('collecting finalized history…');
 const history=await H.collect(rpc,mint,{onProgress:p=>log(`addresses ${p.addresses}, pending ${p.pending}, transactions ${p.transactions}`)});
 report.coverage=history.coverage;report.markets=history.markets;
 const coin={mint,intake:null,sharing_config:null,current_creator:null};
 const parsed=H.parseAll(history,coin);report.events={total:parsed.events.length,byKind:parsed.events.reduce((m,e)=>(m[e.kind]=(m[e.kind]||0)+1,m),{}),parserHolds:parsed.holds.length};
 const head=await rpc.call('getBlockTime',[history.coverage.throughSlot]);
 const cutoffArg=arg('cutoff','latest'),cutoff=cutoffArg==='latest'?Math.min(head,Math.floor(Date.now()/1000))-120:Number(cutoffArg);
 const cs=await H.findCutoffSlot(rpc,cutoff);report.cutoff={time:cutoff,iso:new Date(cutoff*1000).toISOString(),...cs};
 if(cs.slot==null){report.blockers.push({reason:cs.reason});return finish(report,out);}
 // SOL/USD: purchase times (cost basis) + the reference window at the cutoff.
 const purchaseTimes=parsed.events.filter(e=>e.kind==='purchase_candidate'&&e.time<=cutoff).map(e=>Number(e.time));
 const windowTimes=[];for(let t=cutoff-90;t<=cutoff;t+=10)windowTimes.push(t);
 let series=[];
 try{
  if(process.env.PYTH_API_KEY){for(const t of [...new Set([...purchaseTimes,...windowTimes])])series.push(...await FX.hermesAt(t,{window:30}));report.solUsdSource='pyth-benchmarks';}
  else{log('SOL/USD from the on-chain Pyth feed history…');series=await FX.onchainHistory(rpc,[...purchaseTimes,...windowTimes]);report.solUsdSource='pyth-onchain-history';}
 }catch(e){report.blockers.push({reason:e.code||'SOL_USD_SOURCE_UNAVAILABLE',detail:e.message});}
 series=[...new Map(series.map(o=>[o.time,o])).values()].sort((a,b)=>a.time-b.time);
 report.solUsd={observations:series.length,window:series.filter(o=>o.time>=cutoff-90&&o.time<=cutoff).map(o=>({time:o.time,priceUsdPico:String(o.price),confUsdPico:String(o.conf)})),
  purchaseTimes:purchaseTimes.length,purchaseTimesPriced:purchaseTimes.filter(t=>FX.lookup(series)(t)).length};
 const excluded=new Set([history.markets.curve,history.markets.pool,history.markets.poolAuthority]);
 const reserve=BigInt(arg('reserve','1000000000'));
 const snapshot=S.build({mint,cycle:0,cutoff,cutoffSlot:cs.slot,events:parsed.events,parserHolds:parsed.holds,coverage:history.coverage,excluded,fx:FX.lookup(series),solSeries:series,holderReserve:reserve});
 report.hypotheticalHolderReserveLamports=String(reserve);report.snapshot=snapshot;
 if(snapshot.state==='waiting_for_data')report.blockers.push({reason:snapshot.reason});
 report.summary={state:snapshot.state,reason:snapshot.reason||null,holders:snapshot.positions?.length||0,
  outcomes:(snapshot.positions||[]).reduce((m,p)=>(m[p.outcome+(p.reason?':'+p.reason:'')]=(m[p.outcome+(p.reason?':'+p.reason:'')]||0)+1,m),{}),
  awards:snapshot.awards?.length||0,totalLamports:snapshot.total||'0',snapshotHash:snapshot.snapshotHash||null,rpcCalls:rpc.calls,seconds:Math.round((Date.now()-started)/1000)};
 return finish(report,out);
}
function finish(report,out){const text=stable(report);if(out)fs.writeFileSync(out,text);process.stdout.write(JSON.stringify({summary:report.summary||null,blockers:report.blockers,coverage:report.coverage&&{complete:report.coverage.complete,transactions:report.coverage.transactions,addresses:report.coverage.addresses,incomplete:report.coverage.incomplete?.slice(0,5)}},null,1)+'\n');}
main().catch(e=>{process.stderr.write('preview failed: '+(e.code||'')+' '+String(e.message).replace(/https?:\/\/\S+/g,'[endpoint]')+'\n');process.exitCode=1;});
