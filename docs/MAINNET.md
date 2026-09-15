# Mainnet activation status

The public interface contains no simulated markets, trades, wallet funds, token creation, claims, or payouts. It is a live-data interface while the launch and rewards integrations are unfinished. Publishing the website does not deploy a Solana program or create a token.

## Token and hosting

Initial mint supplied by the owner: `3SohGcVPEwv6HS4DcSCMBE6RKu623aVzZKh4oWFppump`.

On September 15, 2026, the public Solana mainnet RPC returned `value: null` for this address at finalized slot 447219328; DEX Screener returned an empty pair list. This could be a reserved address. It must be rechecked after creation. Creating this exact mint requires its locally controlled mint keypair; a public address alone is insufficient. Never submit a private key to chat or commit it.

At that check, `reboundpad.fun` returned `server: GitHub.com`. GitHub Pages cannot run the Netlify function. Keep the current site reachable until the Netlify deployment and HTTPS are verified, then change only the relevant domain records to the target Netlify provides.

## Netlify

- Connect this repository, branch `main`.
- Build command: `node scripts/build.cjs`. Publish directory: `dist`. Functions directory: `netlify/functions`. Node version: 24. All are in `netlify.toml`.
- Add `SOLANA_RPC_URL` in Netlify environment variables, mark secret, enable Functions scope and Production context, then redeploy. Use an HTTPS Solana mainnet endpoint.
- Do not use a public-prefixed environment variable or insert the endpoint into HTML, client JavaScript, or build output.
- Verify `/.netlify/functions/chain?action=status` returns `cluster: mainnet-beta`. Verify the configured mint lookup and a connected wallet's balances.
- Add the custom domain to the correct Netlify project. Use its domain-specific DNS instructions and verify both apex and www, including HTTPS, before treating the migration as complete.

The API exposes only status, initialized-mint lookup, and wallet balances. It validates mainnet genesis, fixes commitment to finalized, rejects transaction methods, limits request rate and response size, and sanitizes upstream errors. The in-process rate budget is per warm function instance; it is not a global RPC spending cap. Set provider quotas as appropriate. Browser requests can never choose an upstream URL. Neither the client-side password screen nor wallet connection is API authentication.

## Pump.fun and creator-fee routing

Pump.fun supplies token creation, the initial bonding curve, and eventual PumpSwap trading. A manually created liquidity pool is not a prerequisite.

REBOUND must construct real transactions using the official Pump SDK and validated mainnet state. This integration is not implemented by the read-only website release. Before enabling launch:

1. Choose and verify who receives creator fees for each coin. Launch attribution must come from confirmed creation transactions and configured fee recipients, not a browser-local token list.
2. For the custom REBOUND policy, use regular creator-fee coins. Pump.fun's native holder-reward option redirects creator fees away from the creator and is permanent; it is a different reward mechanism. Do not enable it accidentally.
3. Collect both pre-graduation Pump fees and post-graduation PumpSwap fees. Regular single-creator collection is permissionless but pays the configured creator, not the caller. A fee-sharing coin requires the Pump Fees sharing flow.
4. Route actual collected fees into the correct REBOUND vault. Do not sweep a creator's entire wallet or conflate several coins' funds. If a shared creator address aggregates fees across coins, isolate recipients or build independently verifiable per-coin attribution before allocating them.
5. Handle native SOL and wrapped SOL settlement correctly after graduation. Verify confirmed transactions and receipt amounts before recording funds as available.
6. Submit gross collected creator fees to the REBOUND accounting boundary once. Its program applies 85% holders / 15% operations; do not split twice.

A program-owned vault as fee recipient is a design possibility, not a validated configuration in this release. It requires verification against both Pump and PumpSwap account rules and the REBOUND program's deposit/sync behavior.

## Reward deployment

The repository contains candidate contract code, not a deployed mainnet program. Public program, admin, publisher, guardian, operations, and initialized vault addresses must be established. No private key should be held by the website or its public RPC function.

Production work still required:
- Build, review, deploy and initialize the reward program with the intended authorities and supplied real token mint.
- Index finalized purchases, sales, transfers, cost basis, and price history; implement the spot/15-minute reference rules and outgoing-transfer exclusions.
- Collect genuine creator fees; publish auditable, fully funded reward rounds with correction windows.
- Run the hourly publisher and payout worker with independent monitoring and retry handling. The existing payout worker consumes proofs; it does not create trustworthy economic history by itself.
- Exercise creation, a small buy and sell, fee collection before and after graduation, vault funding, and a real payout under user-controlled signing. Verify all transactions in an explorer. Mainnet transactions are irreversible and require the owner to review wallet prompts.

There is no frontend switch that can substitute for these integrations.

## Charts

The official TradingView Advanced Chart widget displays Coinbase SOL/USD on Discover and Analytics. It is explicitly labeled as SOL market context. Token detail pages use actual DEX Screener pair embeds selected by exact Solana mint, preferring liquidity. Missing markets show no chart or invented candles. Provider/indexer data is not used to construct or price transactions.

## References

- [Pump SDK and current protocol docs](https://github.com/pump-fun/pump-public-docs)
- [Coin creation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md)
- [Creator fee collection](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md)
- [Creator fee sharing](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md)
- [TradingView widget integration](https://www.tradingview.com/widget-docs/tutorials/build-page/widget-integration/)
- [DEX Screener API](https://docs.dexscreener.com/api/reference)
- [Netlify function environment variables](https://docs.netlify.com/build/functions/environment-variables/)
