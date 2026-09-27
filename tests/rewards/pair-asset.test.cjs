'use strict';
// Coins paired with another quote asset (migration 021): purchases are proven by the buyer's payment in that
// asset, losses and awards are in its base units, the wallet's income ledger is kept in it, the vault pays at most
// 20 % per round, and payouts are SPL transfers to each holder's account of the asset (created from the wallet's
// SOL float when missing). The 15 % never pays holders.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Keypair,PublicKey,Transaction,SystemProgram}=require('@solana/web3.js');
const {TOKEN_PROGRAM_ID,MINT_SIZE,createInitializeMint2Instruction,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createMintToInstruction}=require('@solana/spl-token');
const {SvmConnection}=require('./svm-connection.cjs'),{supabaseDb}=require('./pg.cjs'),{chain}=require('./chain-fixture.cjs');
const P3=require('../../server/rewards/policy-v3.cjs'),D=require('../../server/rewards/cycle-direct.cjs'),A=require('../../server/rewards/admin-v3.cjs'),Signer=require('../../server/rewards/signer.cjs');
const L=require('../../server/rewards/lots-v3.cjs'),I=require('../../server/rewards/indexer.cjs'),F=require('../../server/rewards/primary-funding.cjs'),FS=require('../../server/rewards/funding-store.cjs'),DBm=require('../../server/rewards/db.cjs');
const T0=1_800_000_000,U=10n**6n;   // the pair asset has 6 decimals: 1 unit = 1_000_000 base units
process.env.REWARDS_MAX_EXECUTION_MODE='mainnet_test';

test('lots: a pair coin\'s purchase is proven by the buyer\'s payment in its quote asset, never by SOL',()=>{
 const Q=Keypair.generate().publicKey.toBase58();
 const c=chain({startSlot:100});
 c.tx(x=>x.buy('alice','a1',1000n,{lamports:5n*U,fee:50_000n,creatorFee:25_000n,quote:Q}));
 c.tx(x=>x.buy('bob','b1',1000n,{lamports:5n*U,fee:50_000n,creatorFee:25_000n}));   // paid in SOL: not a purchase of this coin
 const r=L.replay(c.events,{excluded:new Set(['CurvePDA']),fx:t=>({time:t,price:P3.LAMPORTS,conf:0n,source:'sol-unit'}),quoteAsset:Q});
 const alice=r.owners.get('alice').lots[0];assert.equal(alice.kind,'purchase');assert.equal(alice.costLamports,5n*U+75_000n,'cost in the pair asset, fees included');
 assert.notEqual(r.owners.get('bob').lots[0].kind,'purchase','a SOL payment does not prove a pair purchase');
 // The same history for a SOL coin: the pair trade is not a SOL purchase.
 const s=L.replay(c.events,{excluded:new Set(['CurvePDA']),fx:t=>({time:t,price:P3.LAMPORTS,conf:0n,source:'sol-unit'})});
 assert.notEqual(s.owners.get('alice').lots[0].kind,'purchase');
 // A pair trade paid in another asset is not proven either.
 const other=Keypair.generate().publicKey.toBase58(),c2=chain({startSlot:100});
 c2.tx(x=>x.buy('carol','c1',1000n,{lamports:5n*U,quote:other}));
 const r2=L.replay(c2.events.map(e=>e.kind==='purchase_candidate'?{...e,data:{...e.data,quoteAsset:Q}}:e),{excluded:new Set(['CurvePDA']),fx:t=>({time:t,price:P3.LAMPORTS,conf:0n,source:'sol-unit'}),quoteAsset:Q});
 assert.equal(r2.owners.get('carol').lots[0].basisPending,'purchase_amounts_unproven');
});

test('indexer: the pair coin\'s pool is derived with its quote; trades are tagged with the coin\'s asset',()=>{
 const mint=Keypair.generate().publicKey.toBase58(),Q='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
 const P=require('@pump-fun/pump-sdk');
 assert.equal(I.poolOf({mint}),P.canonicalPumpPoolPda(new PublicKey(mint)).toBase58());
 assert.equal(I.poolOf({mint,quote_mint:Q}),P.canonicalPumpPoolPdaWithQuote(new PublicKey(mint),new PublicKey(Q)).toBase58());
 assert.notEqual(I.poolOf({mint}),I.poolOf({mint,quote_mint:Q}));
 const PUMP=P.PUMP_PROGRAM_ID.toBase58(),AMM=P.PUMP_AMM_PROGRAM_ID.toBase58();
 assert.equal(I.tradeAsset({mint},PUMP,{quoteMint:PublicKey.default.toBase58()}),'native-SOL');
 assert.equal(I.tradeAsset({mint,quote_mint:Q},PUMP,{quoteMint:Q}),Q);
 assert.equal(I.tradeAsset({mint,quote_mint:Q},PUMP,{quoteMint:PublicKey.default.toBase58()}),'unsupported');
 assert.equal(I.tradeAsset({mint},PUMP,{quoteMint:Q}),'unsupported');
 assert.equal(I.tradeAsset({mint,quote_mint:Q},AMM,{}),Q);assert.equal(I.tradeAsset({mint},AMM,{}),'native-SOL');
});

test('ledger: a pair coin\'s wallet is reconciled in its quote asset (fees in, payouts and swaps out)',()=>{
 const W=Keypair.generate().publicKey.toBase58(),Q=Keypair.generate().publicKey.toBase58(),mine='ownQ',vault='vaultQ',holder='holderQ';
 const tx=({sig,pre,post,transfers})=>({slot:5,blockTime:T0,transaction:{signatures:[sig],message:{accountKeys:[W,mine,vault,holder].map(p=>({pubkey:p})),instructions:transfers.map(t=>({programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',parsed:{type:'transferChecked',info:{source:t[0],destination:t[1],tokenAmount:{amount:String(t[2])}}}}))}},
  meta:{err:null,fee:5000,preBalances:[1,0,0,0],postBalances:[1,0,0,0],innerInstructions:[],
   preTokenBalances:[{accountIndex:1,mint:Q,owner:W,uiTokenAmount:{amount:String(pre)}}],postTokenBalances:[{accountIndex:1,mint:Q,owner:W,uiTokenAmount:{amount:String(post)}}]}});
 const inFee=F.classifyToken(tx({sig:'s1',pre:0,post:3_000_000,transfers:[[vault,mine,3_000_000]]}),W,Q);
 assert.equal(inFee.inflow,3_000_000n);assert.equal(inFee.outflow,0n);assert.equal(inFee.postBalance,3_000_000n);assert.equal(inFee.fee,0n,'SOL fees are not part of this ledger');
 const out=F.classifyToken(tx({sig:'s2',pre:3_000_000,post:2_000_000,transfers:[[mine,holder,1_000_000]]}),W,Q,new Map([['s2',{kind:'holder_deposit',amount:'1000000'}]]));
 assert.equal(out.outflow,1_000_000n);assert.equal(out.intent.kind,'holder_deposit');
 const other=F.classifyToken({...tx({sig:'s3',pre:0,post:0,transfers:[]}),meta:{err:null,fee:5000,preBalances:[1],postBalances:[1],preTokenBalances:[],postTokenBalances:[]}},W,Q);
 assert.equal(other.unrelated,true,'a transaction without the wallet\'s asset account is not part of the ledger');
 // 85/15 once, in the asset's units.
 const r=F.reconcile({credited:0n,holderAwaiting:0n,holderAvailable:0n,holderReserved:0n,holderPaid:0n,retained:0n,carry:0,operationalReserve:0n,throughSlot:null},[inFee]);
 assert.equal(r.state.holderAwaiting,2_550_000n);assert.equal(r.state.retained,450_000n);assert.equal(r.incidents.length,0);
});

// ---------------- a full round of a pair coin on the SVM ----------------
async function send(conn,payer,ixs,signers=[]){const bh=await conn.getLatestBlockhash();const t=new Transaction({feePayer:payer.publicKey,recentBlockhash:bh.blockhash}).add(...ixs);t.sign(payer,...signers);await conn.sendRawTransaction(t.serialize());}
test('pair round: the vault pays at most 20 % in the quote asset by SPL transfer; a missing holder account is created from the SOL float; the 15 % is kept',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rebound-pair-'));const env={...process.env,REWARDS_SIGNER_MASTER_KEY_FILE:path.join(dir,'master.key')};
 fs.writeFileSync(env.REWARDS_SIGNER_MASTER_KEY_FILE,require('node:crypto').randomBytes(32).toString('hex'),{mode:0o600});
 const conn=new SvmConnection();conn.setTime(T0,1000);
 const dev=Keypair.generate(),qMint=Keypair.generate();conn.airdrop(dev.publicKey,100_000_000n);   // 0.1 SOL for fees and account rent
 const Q=qMint.publicKey.toBase58(),ata=o=>getAssociatedTokenAddressSync(qMint.publicKey,new PublicKey(o),true,TOKEN_PROGRAM_ID);
 await send(conn,dev,[SystemProgram.createAccount({fromPubkey:dev.publicKey,newAccountPubkey:qMint.publicKey,lamports:await conn.getMinimumBalanceForRentExemption(MINT_SIZE),space:MINT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeMint2Instruction(qMint.publicKey,6,dev.publicKey,null,TOKEN_PROGRAM_ID)],[qMint]);
 await send(conn,dev,[createAssociatedTokenAccountIdempotentInstruction(dev.publicKey,ata(dev.publicKey),dev.publicKey,qMint.publicKey),createMintToInstruction(qMint.publicKey,ata(dev.publicKey),dev.publicKey,10n*U)]);
 const people=Array.from({length:3},()=>Keypair.generate().publicKey.toBase58());
 // Two holders already have an account of the asset (they bought with it); the third does not.
 await send(conn,dev,people.slice(0,2).map(p=>createAssociatedTokenAccountIdempotentInstruction(dev.publicKey,ata(p),new PublicKey(p),qMint.publicKey)));
 const c=chain({startSlot:100,timeOf:s=>T0+(s-100)});const hi={vSol:300n*U,vTok:10n**12n};
 people.forEach((p,i)=>c.tx(x=>x.buy(p,'acct'+i,1_000_000n,{lamports:BigInt(4-i)*U,fee:0n,creatorFee:0n,quote:Q,...hi})));
 c.tx(x=>x.buy(Keypair.generate().publicKey.toBase58(),'late',10n**9n,{lamports:1000n,fee:0n,creatorFee:0n,quote:Q,vSol:30n*U,vTok:10n**12n}));   // price drops 10×
 const db=await supabaseDb();const mint=Keypair.generate().publicKey.toBase58();
 try{
  await db.query("UPDATE reward_platform SET execution_mode='mainnet_test' WHERE namespace='mainnet_test'");
  await db.query('SET ROLE rebound_api');
  try{await A.launch(db,'admin (password)',{},{mint,feeWallet:dev.publicKey.toBase58(),namespace:'mainnet_test',fundingModel:'income',startTest:true},{connection:null});}finally{await db.query('RESET ROLE');}
  await db.query("UPDATE reward_platform SET spend_cap_action_lamports=$1,spend_cap_cycle_lamports=$1,spend_cap_total_lamports=$1 WHERE namespace='mainnet_test'",[String(10n**9n)]);
  const policy='rebound-v3.1-test';
  await db.query('UPDATE reward_coins SET schedule_anchor=$2,policy_version=$3,policy_hash=$4,quote_mint=$5,quote_token_program=$6,quote_decimals=6,quote_symbol=$7 WHERE mint=$1',[mint,T0,policy,P3.hashOf(P3.policy(policy)),Q,TOKEN_PROGRAM_ID.toBase58(),'USDX']);
  await db.query("UPDATE reward_funding_wallets SET opening_slot=0,opening_balance_lamports=0,opening_credit_lamports=0,operational_reserve_lamports=0 WHERE mint=$1",[mint]);
  const s=await Signer.importSigner(db,{role:'primary_dev',secretText:JSON.stringify(Array.from(dev.secretKey)),expectedAddress:dev.publicKey.toBase58(),env});
  await db.query("UPDATE reward_funding_wallets SET mode='automatic',signer=$2 WHERE mint=$1",[mint,s.id]);
  await db.query("INSERT INTO reward_public_tokens(mint,namespace,kind,reward_status,pinned,test) VALUES($1,'mainnet_test','primary','active',true,true)",[mint]);
  // 10 units of fees reached the wallet: 8.5 is the holders' vault, 1.5 stays (the 15 %).
  await DBm.transaction(db,async tx=>{await tx.query("INSERT INTO reward_funding_accounts(mint,kind) VALUES($1,'primary') ON CONFLICT DO NOTHING",[mint]);
   await FS.applyCredits(tx,mint,[{id:'fee1',signature:'fee-sig',slot:5,time:T0+5,gross:10n*U}]);});
  const fw=async()=>(await db.query('SELECT * FROM reward_funding_wallets WHERE mint=$1',[mint])).rows[0];
  const a0=await D.available(db,conn,await fw());
  assert.equal(a0.vault,85n*U/10n);assert.equal(a0.lamports,17n*U/10n,'a round may take 20 % of the vault: 1.7 units');
  const inputs=async(coinRow,n,cutoff,slot)=>({credits:await require('../../server/rewards/worker-v3.cjs').loadCredits(db,mint,slot),events:c.events,coverage:{complete:true,throughSlot:10_000},excluded:new Set(['CurvePDA']),fx:()=>null,solSeries:[]});
  const ports={db,connection:conn,worker:'w1',inputs,env,cutoffSlot:async t=>1000+(t-T0),now:async()=>conn.getBlockTime(),signer:f=>Signer.load(db,f.signer,{env})};
  const coin=async()=>(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0];
  const tick=async(k=3)=>{for(let i=0;i<k;i++){conn.finalizeAll();await D.tick(ports,await coin());}};
  await tick(1);conn.setTime(T0+90,1500);await tick();
  const row=(await db.query('SELECT * FROM reward_cycles WHERE id=$1',[`${mint}:1`])).rows[0];assert.equal(row.state,'funded');
  const awards=(await db.query('SELECT * FROM reward_awards WHERE cycle_id=$1 ORDER BY leaf_index',[`${mint}:1`])).rows;
  const total=awards.reduce((x,a)=>x+BigInt(a.amount_lamports),0n);assert.equal(awards.length,3);
  assert.ok(total<=17n*U/10n&&total>=17n*U/10n-3n,'20 % of the vault, in the asset: '+total);
  conn.setTime(T0+125,1600);await tick();
  const paid=(await db.query('SELECT * FROM reward_awards WHERE cycle_id=$1 ORDER BY leaf_index',[`${mint}:1`])).rows;
  assert.ok(paid.every(a=>a.state==='paid'),'every award paid: '+paid.map(a=>a.state));
  for(const a of paid){const b=BigInt((await conn.getTokenAccountBalance(ata(a.recipient))).value.amount);assert.equal(b,BigInt(a.amount_lamports),'paid in the asset to the holder\'s account');}
  assert.ok(await conn.getAccountInfo(ata(people[2])),'the missing holder account was created from the SOL float');
  const left=BigInt((await conn.getTokenAccountBalance(ata(dev.publicKey))).value.amount);assert.equal(left,10n*U-total,'the 15 % and the rest of the vault stay on the wallet');
  assert.ok(left>=15n*U/10n,'the 15 % is never paid out');
  const pub=(await db.query('SELECT sum(amount_lamports)::text s FROM reward_public_payouts WHERE mint=$1',[mint])).rows[0].s;assert.equal(BigInt(pub),total);
 }finally{await db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

// ---------------- the 15 %: swap to SOL, guarded by the simulation ----------------
test('swap: only the 15 % may be swapped, and a swap the simulation shows returning less SOL (or taking more) is refused',async()=>{
 const {createTransferCheckedInstruction}=require('@solana/spl-token');
 const TP=require('../../server/rewards/third-party-direct.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rebound-swap-'));const env={...process.env,REWARDS_SIGNER_MASTER_KEY_FILE:path.join(dir,'master.key'),JUPITER_API_URL:'https://jup.test'};
 fs.writeFileSync(env.REWARDS_SIGNER_MASTER_KEY_FILE,require('node:crypto').randomBytes(32).toString('hex'),{mode:0o600});
 const conn=new SvmConnection();conn.setTime(T0,1000);
 const creator=Keypair.generate(),qMint=Keypair.generate(),sink=Keypair.generate();conn.airdrop(creator.publicKey,100_000_000n);
 const Q=qMint.publicKey.toBase58(),ata=o=>getAssociatedTokenAddressSync(qMint.publicKey,new PublicKey(o),true,TOKEN_PROGRAM_ID);
 await send(conn,creator,[SystemProgram.createAccount({fromPubkey:creator.publicKey,newAccountPubkey:qMint.publicKey,lamports:await conn.getMinimumBalanceForRentExemption(MINT_SIZE),space:MINT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeMint2Instruction(qMint.publicKey,6,creator.publicKey,null,TOKEN_PROGRAM_ID)],[qMint]);
 await send(conn,creator,[createAssociatedTokenAccountIdempotentInstruction(creator.publicKey,ata(creator.publicKey),creator.publicKey,qMint.publicKey),createAssociatedTokenAccountIdempotentInstruction(creator.publicKey,ata(sink.publicKey),sink.publicKey,qMint.publicKey),createMintToInstruction(qMint.publicKey,ata(creator.publicKey),creator.publicKey,10n*U)]);
 const db=await supabaseDb();const mint=Keypair.generate().publicKey.toBase58(),saved=global.fetch;
 try{
  await db.query("UPDATE reward_platform SET execution_mode='mainnet_test',test_allowlist_mints=ARRAY[$1],spend_cap_action_lamports=$2,spend_cap_cycle_lamports=$2,spend_cap_total_lamports=$2 WHERE namespace='mainnet_test'",[mint,String(10n**9n)]);
  const pol='rebound-v3.2-test';
  await db.query(`INSERT INTO reward_coins(mint,policy_hash,status,kind,namespace,program_version,policy_version,intake,creator_wallet,quote_mint,quote_token_program,quote_decimals,quote_symbol,primary_target_mint)
   VALUES($1,$2,'active','third_party','mainnet_test','v3',$3,$4,$4,$5,$6,6,'USDX',$7)`,[mint,P3.hashOf(P3.policy(pol)),pol,creator.publicKey.toBase58(),Q,TOKEN_PROGRAM_ID.toBase58(),Keypair.generate().publicKey.toBase58()]);
  const s=await Signer.importSigner(db,{role:'launch_creator',secretText:JSON.stringify(Array.from(creator.secretKey)),expectedAddress:creator.publicKey.toBase58(),env});
  await db.query("INSERT INTO reward_creator_wallets(address,signer,status,mint) VALUES($1,$2,'assigned',$3)",[creator.publicKey.toBase58(),s.id,mint]);
  const fwId=require('node:crypto').randomUUID();
  await db.query(`INSERT INTO reward_funding_wallets(id,namespace,mint,address,mode,signer,ownership_proof,operational_reserve_lamports,status,funding_model,opening_slot)
   VALUES($1,'mainnet_test',$2,$3,'automatic',$4,'{}','0','active','income',0)`,[fwId,mint,creator.publicKey.toBase58(),s.id]);
  await DBm.transaction(db,async tx=>{await tx.query("INSERT INTO reward_funding_accounts(mint,kind) VALUES($1,'primary') ON CONFLICT DO NOTHING",[mint]);
   await FS.applyCredits(tx,mint,[{id:'fee1',signature:'fee-sig',slot:5,time:T0+5,gross:10n*U}]);});
  const coin=(await db.query('SELECT * FROM reward_coins WHERE mint=$1',[mint])).rows[0],fw=(await db.query('SELECT * FROM reward_funding_wallets WHERE id=$1',[fwId])).rows[0];
  // A fake Jupiter: the quote says 1.5 units → 0.02 SOL; the "swap" only moves `take` units to a sink (no SOL comes back).
  let asked=null,take=null;
  global.fetch=async(url,init={})=>{const u=new URL(String(url));
   if(u.pathname.endsWith('/quote')){asked=u.searchParams.get('amount');return{ok:true,json:async()=>({inputMint:Q,outputMint:'So11111111111111111111111111111111111111112',inAmount:asked,outAmount:'20000000',otherAmountThreshold:'19800000'})};}
   const ix=createTransferCheckedInstruction(ata(creator.publicKey),qMint.publicKey,ata(sink.publicKey),creator.publicKey,take??BigInt(asked),6,[],TOKEN_PROGRAM_ID);
   return{ok:true,json:async()=>({swapInstruction:{programId:ix.programId.toBase58(),accounts:ix.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),data:ix.data.toString('base64')},addressLookupTableAddresses:[]})};};
  const r=await TP.swapPair({db,connection:conn,env},coin,fw);
  assert.equal(asked,String(15n*U/10n),'only the 15 % (1.5 units) is offered for the swap; the vault is not');
  assert.equal(r.state,'held');assert.equal(r.err,'swap_returns_less_sol_than_quoted');
  assert.equal(BigInt((await conn.getTokenAccountBalance(ata(creator.publicKey))).value.amount),10n*U,'nothing left the wallet');
  assert.equal((await db.query('SELECT state FROM reward_swaps WHERE mint=$1',[mint])).rows[0].state,'failed');
  take=15n*U/10n+1n;const r2=await TP.swapPair({db,connection:conn,env},coin,fw);
  assert.equal(r2.err,'swap_takes_more_than_the_15_percent');
  // Jupiter answering for another amount or asset is refused before anything is built.
  global.fetch=async()=>({ok:true,json:async()=>({inputMint:Q,outputMint:'So11111111111111111111111111111111111111112',inAmount:'1',outAmount:'20000000',otherAmountThreshold:'19800000'})});
  await assert.rejects(TP.swapPair({db,connection:conn,env},coin,fw),e=>e.code==='SWAP_QUOTE_INVALID');
 }finally{global.fetch=saved;await db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('dust: awards below the minimum are not paid; a round of only tiny awards pays nothing and keeps the money',()=>{
 const snap={state:'ready',total:'300',awards:[{index:0,owner:'a',lamports:'150000'},{index:1,owner:'b',lamports:'99999'},{index:2,owner:'c',lamports:'6'}]};
 const r=D.dropDust(snap,D.MIN_AWARD_LAMPORTS);assert.deepEqual(r.awards.map(a=>a.owner),['a']);assert.equal(r.total,'150000');assert.equal(r.dust,2);
 const none=D.dropDust({state:'ready',total:'8',awards:[{index:0,owner:'a',lamports:'6'},{index:1,owner:'b',lamports:'2'}]},D.MIN_AWARD_LAMPORTS);
 assert.equal(none.state,'skipped_no_funds');assert.equal(none.awards.length,0);
 assert.equal(D.dropDust(snap,0n),snap);
});
