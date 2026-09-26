# V3 module plan — mapping existing code to the new specification

Base: `rewards-v2-implementation` @ `c7bde3e18a6b695650e14e3c26a6b0a856f0f3f3` (unchanged on the remote on
26 Sep 2026; `main` also unchanged at `648956847fd94ee9cb4fd0217777467991f07608`). Live `rebound.wtf`
health endpoint still serves the V2 policy (`rebound-sol-v2.1`, `setup_required`).

Legend: **Keep** = reuse as is · **Adapt** = change in place · **Replace** = new V3 module, old one kept
only until callers are migrated · **Historical** = never deployed.

## Architecture decisions (binding for M1–M6)

1. **One ledger.** Supabase Postgres holds all business state. Migration `005_v3` extends existing
   `reward_*` tables additively (new columns, replaced CHECK constraints) and adds tables only for new
   concepts (lot credits, funding credits, cycles, buyback jobs, logs, users/roles, public projections).
   Applied migration files 001–004 are never edited.
2. **Program V3** (`contracts/v3/`, new PDA seeds `*-v3`, new magic bytes) derived from V2:
   - Coin kinds `primary` / `third_party`; per-coin `anchor`, `cycle_seconds`, `cutoff_lead`.
   - `DepositHolders` (primary only): the registered dev funding wallet signs; lamports go straight to
     holder `unallocated` — **no split**.
   - `Credit` (third-party only, verifier-attested receipt as in V2): split once 85/15 into holder
     `unallocated` and `buyback_available`, per-mint carry.
   - `Fund` (publisher + verifier signatures): only in `[cutoff(n), cutoff(n+1))`, stores `due_time`.
   - `Pay` (permissionless crank): Merkle-sum proof → creates a replay-protection receipt PDA and pays the
     fixed wallet the fixed amount, only when `now ≥ due_time` and not paused. No fresh market/holding
     check — snapshot-locked awards (spec §4). Position/exit accounts of V2 are dropped.
   - `ReserveBuyback` / `BuybackSwap` / `BuybackBurn`: 15% budget moves to a per-source-mint system-owned
     buyback PDA; swap CPI into Pump `buy_exact_sol_in` or PumpSwap `buy_exact_quote_in` bound to the
     job's stored target mint with operator-provided `min_out > 0`; burn CPI through the mint's actual
     token program; inventory/burn receipts on chain. Burn retries never re-buy.
   - Pause / request-resume / resume and governed authority rotation kept from V2.
3. **Workers**: one restartable Node worker process (roles `indexer`, `scheduler`, `market`) plus the
   independent verifier service. Durable row leases in `reward_jobs` (no session advisory locks, so the
   Supabase transaction pooler is safe). Netlify functions only serve short API requests.
4. **Auth**: Privy (wallet discovery/connection) → Supabase `signInWithWeb3` (Solana) with an adapter bound
   to the exact selected wallet → Supabase JWT sent to Netlify functions, which verify it with Supabase
   and load roles from server-controlled `app_admins` / wallet bindings. Admin is bootstrapped by SQL.
5. **Realtime**: Postgres changes on RLS-protected public projection tables (`public_token_cards`,
   `public_cycles`) for anonymous clients; admin logs on `reward_logs` visible only to `admin` role via RLS.
   The worker writes projections; browsers never write.
6. **Storage**: bucket `token-assets` (public, immutable content-hash names) for images/metadata JSON;
   bucket `evidence` (private) for manifests/raw evidence. Old Netlify Blobs URIs remain served by the
   compatibility endpoint.
7. **Primary signer (automatic mode)**: encrypted key material (AES-256-GCM, master key only in worker
   env `REWARDS_SIGNER_MASTER_KEY`, never in Supabase) or a mounted key file; Supabase stores only the
   ciphertext reference, public key and readiness. Import is a one-time operator CLI.

## Module map

| Area | File(s) | Treatment | Milestone |
|---|---|---|---|
| Policy | `server/rewards/policy.cjs` | Replace with `policy-v3.cjs` (USD loss, lots, split, TWAP 60 s); V2 file retained for historical replay tests | M2 |
| Lots/projection | `project.cjs` | Adapt: FIFO lots incl. zero-basis incoming; drop exits/links | M2 |
| Snapshot | `snapshot.cjs` | Replace with per-anchor cutoff snapshots (`snapshot-v3.cjs`) | M2 |
| Funding links | `funding.cjs`, `exits.cjs`, `history.cjs` | Removed from active policy (not called); `history.cjs` reused for primary wallet reconciliation | M2 |
| SOL/USD | new `sol-usd.cjs` | Pyth Hermes historical + staleness/confidence checks, evidence rows | M2 |
| Primary funding ledger | new `primary-funding.cjs` | Finalized-event wallet reconciliation, buckets, retained 15% | M2/M3 |
| Indexer | `indexer.cjs` | Keep parser; stop writing disqualifications; add primary-mint backfill mode (signature history of the mint) | M2 |
| Pump adapters | `pump.cjs` | Keep; add buyback swap builders, V3 PDAs | M4 |
| Launch | `launch.cjs` | Adapt: V3 program, `created_pending_activation`, Supabase Storage metadata, activation consent | M4 |
| Metadata | `metadata.cjs` | Replace store with Supabase Storage (`token-assets`), keep Blobs read-compat | M1 |
| DB access | `db.cjs` | Adapt: leases, no session advisory locks, Supabase pooler-safe | M1/M3 |
| Migrations | `migrations/005_v3.sql`, `006_supabase_access.sql` | New | M1 |
| Roles | `scripts/rewards/database-roles.sql` | Adapt for new tables + Supabase (`anon`/`authenticated`/`service_role`) | M1 |
| Transport/receipts | `transport.cjs`, `receipts.cjs` | Keep (durable signed bytes, reconciliation) | M3 |
| Worker | `worker.cjs` | Replace cycle orchestration (`cycle-v3.cjs`), keep run loop pattern | M3 |
| Delivery | `delivery.cjs` | Replace with V3 `Pay` batches, rent-aware deferral | M3 |
| Verifier | `verifier*.cjs` | Adapt: independently recompute V3 manifest; drop payment/exit endpoints | M3 |
| Wire | `wire.cjs` | Add `wire-v3.cjs` for V3 layouts/instructions | M3 |
| Buyback | new `buyback.cjs` | Jobs, quote/slippage/impact checks, swap+burn, burn-only retry | M4 |
| Logs | new `logs.cjs` | Structured, redacted, persisted before notify | M1 |
| Signer | new `signer.cjs`, `scripts/rewards/import-signer.cjs` | Encrypted import, readiness | M3 |
| API | `netlify/functions/rewards.cjs` | Adapt: Supabase JWT auth, public config/tokens, admin endpoints | M1/M5 |
| Program | `contracts/v3/` | New (from V2) | M3/M4 |
| Program V1, `src/engine.cjs` | `contracts/src`, `src/engine.cjs` | Historical — not deployed | — |
| Wallet UI | `src/wallet.js` | Replace with Privy island (`src/privy-island.jsx`) + adapter | M5 |
| Rewards UI | `src/rewards-entry.js` | Adapt copy + data sources | M5 |
| App shell | `src/app.js`, `index.html` | Add token list under search, `#admin`, reward states; keep design | M5 |
| Config | `src/mainnet-config.js` | Remove hardcoded primary mint; load public config from API | M5 |
| Charts | `src/token-charts.js`, `server/charts.cjs` | Keep | — |
| Build | `scripts/build.cjs`, `netlify.toml`, `check-functions.cjs` | Extend for Privy/Supabase bundles | M5 |
| Deploy | `Dockerfile.rewards`, `compose.rewards.yml`, `.env.example` | Adapt | M6 |

## Tests to replace (not delete) — spec §19

`tests/rewards/policy.test.cjs` (maturity/permanent exit) → `tests/rewards/policy-v3.test.cjs`;
`tests/rewards/exits.test.cjs` → assertions that later sales do not change funded awards;
`tests/copy.test.cjs` → asserts the V3 public wording; V2 SVM tests stay for the V2 binary and V3 gets
`contracts/v3/tests/test_svm.py`.
