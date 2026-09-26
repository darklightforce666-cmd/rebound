'use strict';
// REBOUND reward policy V3 — the single source of the economic constants.
// docs/POLICY-V3.md explains every value. Changing any value changes the policy hash,
// which is bound into database rows, round manifests and the V3 program configuration.
const W=require('./wire.cjs');
const {stable}=require('./policy.cjs');

const BASE=Object.freeze({
 asset:'native-SOL',
 lossUnit:'USD',
 usdScale:'1000000000000',            // usd_pico per USD
 priceScale:'1000000000000000000',    // Q18: usd_pico per raw token unit × 10^18
 holdersBps:8500, otherBps:1500,      // split once at the funding boundary
 primaryOther:'retain_on_dev_wallet', thirdPartyOther:'buy_and_burn_primary',
 accounting:'fifo_lots_proportional_integer',
 maturitySeconds:0,
 laterActivity:'funded_award_survives',
 walletLinkExclusion:false, permanentExitOnSale:false,
 transferBasis:'none_for_unproven_incoming',
 referencePrice:'max(spot,twap)', priceWindowSeconds:60,
 maxPriceAgeSeconds:30, maxObservationGapSeconds:30,
 solUsd:{source:'pyth',feedId:'0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',maxAgeSeconds:30,maxConfidenceBps:100},
 minRealQuoteLamports:'0', maxSpotTwapRatioBps:30000,
 buybackMaxSlippageBps:100, buybackHardCapSlippageBps:300, buybackMaxImpactBps:200,
 venues:['pump-curve','pump-amm'],
 pumpHolderRewardMode:false,
 rentPolicy:'defer_undeliverable_as_liability',
});
const POLICY=Object.freeze({...BASE,version:'rebound-v3.0',kind:'production',cycleSeconds:1800,cutoffLeadSeconds:60});
const TEST_POLICY=Object.freeze({...BASE,version:'rebound-v3.0-test',kind:'test',cycleSeconds:120,cutoffLeadSeconds:30});
const hashOf=p=>W.hash(stable(p)).toString('hex');
const POLICY_HASH=hashOf(POLICY),TEST_POLICY_HASH=hashOf(TEST_POLICY);
const POLICIES=Object.freeze({[POLICY.version]:POLICY,[TEST_POLICY.version]:TEST_POLICY});
function policy(version){const p=POLICIES[version];if(!p)throw Error('Unknown policy version');return p;}

// Persist both policy versions (immutable rows) and the platform namespaces. Idempotent.
async function seed(db){
 for(const p of [POLICY,TEST_POLICY])await db.query('INSERT INTO reward_policies(version,hash,canonical,kind) VALUES($1,$2,$3,$4) ON CONFLICT(version) DO NOTHING',[p.version,hashOf(p),stable(p),p.kind]);
 for(const p of [POLICY,TEST_POLICY]){const row=(await db.query('SELECT hash FROM reward_policies WHERE version=$1',[p.version])).rows[0];if(row.hash!==hashOf(p))throw Error('Stored policy '+p.version+' differs from code; create a new policy version');}
 await db.query("INSERT INTO reward_platform(namespace,policy_version) VALUES('production',$1),('mainnet_test',$2) ON CONFLICT DO NOTHING",[POLICY.version,TEST_POLICY.version]);
}
module.exports={POLICY,TEST_POLICY,POLICY_HASH,TEST_POLICY_HASH,POLICIES,policy,hashOf,seed};
