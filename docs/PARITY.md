# Holder reward policy

## Fees

Each net collected creator-fee receipt allocates 85% to holder recovery and 15% to operations. Values are integer lamports. Both shares round down and any remaining lamport stays in a separate dust balance. A receipt identifier cannot be credited twice.

The split applies to newly collected net fees, not trading volume. A 1 SOL receipt allocates 0.85 SOL to holders and 0.15 SOL to operations.

## Recovery and claims

Recognized purchases mature after 15 minutes. The reference price is the higher of spot and a complete 15-minute time-weighted average. Remaining shortfall is mature recorded cost minus reference token value minus all prior funded awards, floored at zero.

Available holder funds are allocated proportionally to shortfalls, capped by the total shortfall and rounded down. Funding reserves amounts immediately and reduces future shortfalls. Generation-4 rounds open at the first UTC hour boundary at least 10 minutes after funding. Only one pending round may exist. A guardian can cancel an incorrect round before it opens and restore the balances. A payout worker sends SOL automatically on the hour and retries failed transfers; recipients do not need to sign. Delayed transfers remain owed.

A sale or outgoing transfer permanently ends future rewards for that wallet/token position. Buying again does not restore them. Already-funded claims survive later sales and can be paid once. Unrecognized incoming tokens do not add cost basis.

The simplified interface keeps reward funding and clock controls inside a collapsed Demo controls section. The portfolio shows token positions, rewards paid, funded unpaid awards, and claims.

## Assets and storage

Trading, treasuries, and holder rewards use SOL with nine decimals. Token quantities use six decimals. USDC remains reference metadata only; stablecoin trading and conversion are disabled.

State uses version 4 and `rebound.demo.holders.v4`. Older simulation keys remain untouched. Old positions, liabilities, and allocations are not silently converted into the current policy.

## Wallets and production scope

The custom wallet popup follows the requested Rainbow-style layout and uses Solana Phantom/Solflare providers. It shares a public address only. Real balances, transaction signing, and transfers are not connected. Mock tests do not substitute for installed-extension testing.

Trading is a fixed-price simulation with a 0.10% to 10% demo creator tax and a separate 1% demo venue fee. Only collected creator tax enters the allocation. These parameters do not assert current Pump.fun settings. Token minting, venue integration, validated activity indexing, production reference pricing, custody programs, and payout execution still require implementation.
