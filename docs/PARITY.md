# Mechanics and implementation scope

## SOL denomination

All enabled tokens trade and pay recovery rewards in SOL. Prices, recognized costs, fee receipts, treasuries, funded awards, payouts, and paper balances use nine-decimal lamport amounts. Token quantities use six decimal places. Fixtures are newly seeded fictional SOL markets, not conversions of old stablecoin balances. Default paper funds are 20 SOL.

USDC is retained as six-decimal reference metadata with no configured production mint. The app rejects USDC token creation, provides no stablecoin reward option, and performs no currency conversion. It cannot mix SOL and USDC balances in a recovery calculation.

## Preserved reference mechanics

| Rule | Local behavior |
| --- | --- |
| Net fee split | 80% holder recovery, 15% operations, 5% $RBD buyback reserve. Integer rounding dust remains accounted for. |
| Recognized purchase | Lot cost and quantity enter the ledger once per activity identifier. |
| Holding period | Recognized lots mature after 15 minutes. |
| Outgoing activity | A sale or outgoing transfer permanently ends future awards for that wallet/token position. Buying again does not restore them. |
| Price reference | Higher of spot and a complete 15-minute time-weighted average. |
| Shortfall | Mature recognized cost minus reference token value minus prior funded awards, floored at zero. |
| Allocation | Available funds allocated proportionally to shortfalls; capped at total shortfall and rounded down. |
| Funded awards | Reserve funds immediately and reduce future shortfalls. |
| Claims | Generation-4 rounds wait 10 minutes. A later outgoing event does not erase an already-funded award. Repeated claims fail. |
| Correction | Guardian can cancel during the funding correction wait; funds and funded basis are restored. |
| Buybacks | Separate 12-hour routing correction and 48-hour activation gates. Activation starts when scheduled. Passing a gate does not execute a purchase. |

Trading uses a fixed quote, a configurable 0.10% to 10% demo creator tax, and a separate 1% demo venue fee. Only the collected creator tax enters the 80/15/5 demo split. These are inherited simulation parameters, not assertions about current Pump.fun fees or supported launch settings. No upstream creator-fee share is added because the adapter is absent.

## Solana / Pump.fun launch work still required

The visual design targets the Solana token audience. Production venue integration, bonding-curve and graduation behavior, token minting, verified activity indexing, reference pricing, program-controlled treasuries, payment execution, and buyback execution are not connected. Deployment requires implementing and testing those components against the selected venue. No Pump.fun affiliation, live listing, or verified protocol parity is implied.

The ledger was recovered from the earlier local prototype. Its Uplift-inspired loss-recovery model is preserved as a reference implementation, not independently verified equivalence to an upstream deployment. Round manifests expose allocation records only; this import does not include cryptographic proof generation or proof-verification tests.

The public-address wallet flow does not fetch real balances, request signatures, or send transactions. All action results refer to the fictional demo holder.
