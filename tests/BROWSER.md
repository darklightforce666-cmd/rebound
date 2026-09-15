# Browser verification

Build and start the local server with a mainnet RPC set in the process environment. Do not sign any transaction during these read-only checks.

1. Enter the existing password 1111. Verify it still locks on refresh.
2. Discover shows only the configured mint and actual provider data. TradingView shows SOL/USD with attribution.
3. Open the supplied mint. If absent onchain or unindexed, confirm explicit absent/error states, no made-up chart or zero rewards.
4. Search a known initialized mint. Confirm exact mint matching and its real market chart when indexed.
5. Open a legacy #token/demo-... link. It must report unavailable, not select a sample token.
6. Connect Phantom or Solflare and open Portfolio. Check actual balances against the wallet. Rejecting connect leaves the app disconnected.
7. Switch wallet accounts while data is loading; old balances must clear and never appear under the new address. Disconnect clears the portfolio.
8. Launch and reward pages explain that integration is incomplete. There are no simulated transaction or payout controls.
9. Test narrow/mobile and desktop widths; addresses must wrap and chart panels must remain inside the viewport.
10. On Netlify, verify the function uses mainnet and no RPC credential appears in browser assets. On a static-only host, wallet/token checks report that the backend is unavailable.
