# REBOUND / $RBD

Solana token prototype. 85% of net collected creator fees funds holders, 15% funds operations. Holder rewards are scheduled hourly in SOL and follow the recorded loss-recovery policy.

All trades, balances, prices, and payouts are simulated. There is no live token mint, Pump.fun integration, or real transfer. The Rainbow-style wallet popup connects to Phantom or Solflare for public-address display only. It does not use the Ethereum RainbowKit SDK.

## Run

Node.js 20 or later. No dependency installation required.

```sh
npm start
# Open http://127.0.0.1:4173
npm test
npm run build
```

Open `preview/REBOUND.html` for a standalone copy. Scripts, page artwork, and fonts are local; browser and sharing icons reference the configured domain. Wallet extension injection may require localhost.

## Project files

- `src/engine.cjs`: integer fee accounting, reward funding, claims, and correction windows.
- `src/fixtures.cjs`: sample SOL markets and position ledgers.
- `src/app.js`: discovery, token creation, paper trading, portfolio, rewards, and wallet popup.
- `src/styles.css`, `src/solana.css`: charcoal and emerald design.
- `src/motion.css`, `src/motion.js`: falling REBOUND artwork, responsive presentation, and saved motion preferences. Device reduced-motion settings take priority.
- `assets/`: logo and banner in editable SVG and PNG formats.
- `tests/`: accounting, wallet mocks, terminology checks, and browser regression steps.
- `docs/PARITY.md`: reward mechanics and prototype scope.
- `docs/VALIDATION.md`: executed validation.
- `contracts/`: Solana rewards program, hourly payout worker, proof builder, deployment settings, and VM tests. See `contracts/README.md` for the trust model and the remaining live integrations.

The current state key is `rebound.demo.holders.v4`. Earlier simulation data stays untouched in older keys and is not imported into this fee policy.
