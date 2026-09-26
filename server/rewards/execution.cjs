'use strict';
// Execution modes and hard spending caps (spec §18.1). The database row reward_platform is the
// authority for the mode; REWARDS_MAX_EXECUTION_MODE on the host is a ceiling it cannot exceed.
//   dry_run      — real reads/calculations; nothing is signed or submitted.
//   mainnet_test — real mainnet, allowlisted mints/wallets, per-action/per-cycle/total caps,
//                  separate namespace; every lamport REBOUND signers move or pay counts.
//   production   — only after activation checks; never enabled by a private test.
const RANK={dry_run:0,mainnet_test:1,production:2};
class ExecutionBlocked extends Error{constructor(code,message){super(message);this.code=code;}}

function ceiling(env=process.env){const m=env.REWARDS_MAX_EXECUTION_MODE||'dry_run';return RANK[m]!=null?m:'dry_run';}

// Check (and, if allowed, atomically record) one action's spend. `tx` must be a DB transaction.
// action: {namespace, mint, recipients:[wallet], lamports (value moved by our signers), fees, cycleId}
async function authorize(tx,action,{env=process.env}={}){
 const p=(await tx.query('SELECT * FROM reward_platform WHERE namespace=$1 FOR UPDATE',[action.namespace])).rows[0];
 if(!p)throw new ExecutionBlocked('SETUP_REQUIRED','Execution namespace is not configured');
 const mode=RANK[p.execution_mode]<=RANK[ceiling(env)]?p.execution_mode:ceiling(env);
 if(p.paused)throw new ExecutionBlocked('PAUSED','Execution is paused'+(p.pause_reason?': '+p.pause_reason:''));
 if(mode==='dry_run')throw new ExecutionBlocked('DRY_RUN','Dry run: no transaction is signed or submitted');
 if(mode==='production'&&action.namespace!=='production')throw new ExecutionBlocked('NAMESPACE','Production mode only executes the production namespace');
 const total=BigInt(action.lamports||0)+BigInt(action.fees||0);
 if(mode==='mainnet_test'){
  if(action.namespace!=='mainnet_test')throw new ExecutionBlocked('NAMESPACE','Test mode only executes the mainnet_test namespace');
  if(action.mint&&!p.test_allowlist_mints.includes(action.mint))throw new ExecutionBlocked('TEST_MINT_NOT_ALLOWED','Mint is not on the test allowlist');
  // test_any_recipient: every eligible holder of an allowlisted test mint may be paid (caps still apply).
  const wallets=new Set(p.test_allowlist_wallets);if(!p.test_any_recipient)for(const w of action.recipients||[])if(!wallets.has(w))throw new ExecutionBlocked('TEST_WALLET_NOT_ALLOWED','Recipient is not on the test allowlist');
  if(total>BigInt(p.spend_cap_action_lamports))throw new ExecutionBlocked('SPEND_CAP_ACTION','Action exceeds the per-action test spend cap');
  if(action.cycleId){
   const used=(await tx.query("SELECT COALESCE(sum((safe_metadata->>'lamports')::numeric),0) AS s FROM reward_logs WHERE event_type='test_spend' AND cycle_id=$1",[action.cycleId])).rows[0].s;
   if(BigInt(String(used).split('.')[0])+total>BigInt(p.spend_cap_cycle_lamports))throw new ExecutionBlocked('SPEND_CAP_CYCLE','Action exceeds the per-cycle test spend cap');
  }
  if(BigInt(p.spent_total_lamports)+total>BigInt(p.spend_cap_total_lamports))throw new ExecutionBlocked('SPEND_CAP_TOTAL','Action exceeds the total test spend cap');
  await tx.query('UPDATE reward_platform SET spent_total_lamports=spent_total_lamports+$2,updated_at=now() WHERE namespace=$1',[action.namespace,String(total)]);
  await tx.query("INSERT INTO reward_logs(severity,component,event_type,namespace,mint,cycle_id,safe_message,safe_metadata) VALUES('info','execution','test_spend',$1,$2,$3,$4,$5)",
   [action.namespace,action.mint||null,action.cycleId||null,`Test spend authorized: ${total} lamports (${action.kind||'action'})`,JSON.stringify({lamports:String(total),kind:action.kind||null})]);
 }
 return{mode,lamports:total};
}
module.exports={RANK,ExecutionBlocked,ceiling,authorize};
