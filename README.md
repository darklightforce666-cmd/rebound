# rebound

Pump.fun launchpad and creator-fee rewards project. The website now reads real market data and, when deployed on Netlify with its RPC secret, finalized Solana balances and mint accounts. No simulated markets, paper trades, generated rewards, or local token launches are loaded by the website.

**This is not a functioning mainnet launch or payout service yet.** Pump.fun transaction construction, creator-fee routing, a deployed REBOUND reward program, a verified history/price indexer, and the reward publisher still need to be connected. The interface keeps these actions unavailable.

## Run

Node.js 24 or later. No package installation is needed.

```sh
npm test
npm start
```

Open http://127.0.0.1:4173. The simple entry-screen password remains `1111`; this is a client-side screen, not server authentication. Charts require internet access. For local wallet/mint checks, set `SOLANA_RPC_URL` in your process environment or an ignored local environment file before starting the server. Never commit an RPC key.

`npm run build` creates `dist/`, containing only browser assets. Netlify builds from `main` using `netlify.toml`. The Node runtime reads the RPC URL at request time; the build never substitutes it into browser code.

## Live features

- Phantom and Solflare public-address connection; no transaction signing.
- Actual SOL and SPL Token / Token-2022 balances through a private read-only Netlify function.
- Mainnet genesis verification and initialized token-mint lookup.
- Public DEX Screener market data selected by exact mint and chain, with actual token chart embeds when a pair exists.
- Official TradingView SOL/USD widget, clearly labeled separately from token charts.
- Errors and missing markets remain unavailable, not replaced by sample prices or zero balances.

The initial mint is `3SohGcVPEwv6HS4DcSCMBE6RKu623aVzZKh4oWFppump`. Configuration is not proof that a mint exists. At the September 15, 2026 check, mainnet returned no account and DEX Screener returned no pair for this address.

See [mainnet activation](docs/MAINNET.md) and [the reward program](contracts/README.md). The accounting engine and fixtures remain test/reference code only; neither is included in the production build.
