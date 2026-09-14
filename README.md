# REBOUND / $RBD

Solana token discovery, local token creation, and fee-funded holder recovery paid in SOL.

This is an interactive prototype. It does not deploy tokens, trade on Pump.fun, hold funds, or send payments. All markets, balances, and claims are simulated. Wallet connection requests a public address only.

## Run and test

Node.js 20 or later. No dependency installation is required.

```sh
npm start
# Open http://127.0.0.1:4173
npm test
npm run build
```

Open `preview/REBOUND.html` for the self-contained version. It needs no server, fonts, remote scripts, or external assets. Browser wallet injection may require localhost.

## Project files

- `src/engine.cjs`: integer recovery accounting, funding, claims, correction windows, and buyback gates.
- `src/fixtures.cjs`: fictional SOL markets and seeded position ledgers. USDC metadata is reference-only.
- `src/app.js`: navigation, token creation, local trading, wallet connection, and saved demo state.
- `src/styles.css`, `src/solana.css`: responsive layout and mint/violet visual system.
- `assets/`: editable SVG mark and social cover.
- `tests/`: accounting and terminology checks, plus repeatable browser test instructions.
- `docs/PARITY.md`: mechanics, denomination policy, and production limitations.
- `docs/VALIDATION.md`: executed checks and their scope.

## Source recovery

The repository initially contained only an initialization README. This version imports the saved `REBOUND-redesign.html` prototype referenced in the earlier task, separates its embedded ledger, fixtures, UI, and styles, then updates the interface and SOL denomination policy. The earlier standalone server, proof tests, and other source archives were not present in the repository or referenced preview, so they are not claimed as part of this import.

The new demo uses storage key `rebound.demo.sol.v2`. Previous saved demo data is left untouched and is not interpreted or converted into SOL. Reset demo clears only the current local simulation.
