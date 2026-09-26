# REBOUND V3 — implementation status

Specification: `REBOUND_IMPLEMENTATION_SPEC_EN.md` v1.0 (owner-supplied, 26 Sep 2026).
Decisions: [POLICY-V3.md](POLICY-V3.md) · Module plan: [V3-MODULE-PLAN.md](V3-MODULE-PLAN.md)

## Branches

| Branch | Commit | Role |
|---|---|---|
| `main` | `648956847fd94ee9cb4fd0217777467991f07608` | Older frontend + V1; untouched |
| `rewards-v2-implementation` | `c7bde3e18a6b695650e14e3c26a6b0a856f0f3f3` | Baseline; untouched |
| `rebound-v3-implementation` | (this branch) | All V3 work |

Remote state was fetched on 2026-09-26: both existing branches were identical to the reviewed commits, so
no newer work needed merging. PR #1 (`rewards-v2-implementation`) is still open upstream.

## How to continue in a new session

1. `git fetch origin && git checkout rebound-v3-implementation`.
2. Read this file top to bottom; the first unchecked item of the lowest open milestone is next.
3. Toolchain: Node 24, pnpm 11.19.0 (`pnpm install --frozen-lockfile --ignore-scripts`), Rust stable,
   Agave 4.2.2 (`cargo build-sbf`), Python 3.11+ with `solders==0.29.0 pytest==8.4.2`.
4. Run `pnpm test` and the program suites listed under "Verification log" before editing.

## M0 — reconcile baseline and freeze decisions ✅

- [x] Fetched both branches; recorded base commits (above).
- [x] Compared deployment: `https://rebound.wtf/.netlify/functions/rewards?action=health` →
      `available:false, state:setup_required, transfersEnabled:false`, policy `rebound-sol-v2.1`
      (V2 economics still published live).
- [x] Read all modules listed in spec §2.2; mapping in `V3-MODULE-PLAN.md`.
- [x] Baseline checks run (see log). 
- [x] Policy decision file `POLICY-V3.md`.
- [x] Official SDK check: `@pump-fun/pump-sdk@2.0.0` and `@pump-fun/pump-swap-sdk@1.20.0` are the current
      npm releases; the pinned IDLs contain `buy_exact_sol_in` (curve) and `buy_exact_quote_in(_v2)`
      (PumpSwap) needed for the buyback. Pyth SOL/USD feed id verified on Hermes.
- [x] Created `rebound-v3-implementation`. No legacy funds/state removed.

## M1 — Supabase, authentication, data boundaries — implemented; 2 external steps open

Supabase project (owner decision, final): **`zuvefozubbgstyljfxjh`** ("Chainlets" → to be renamed
"REBOUND"), eu-central-1, Pro. It still runs PokeDrop (see `LEGACY-CHAINLETS-CLEANUP.md`); REBOUND is
isolated in schema `rebound` and nothing legacy was changed.

- [x] Migrations `005_v3.sql` (V3 data model), `006_supabase_access.sql` (RLS/grants/realtime/buckets),
      `007_harden_functions.sql` (advisor 0011) — applied to the live project; fingerprint identical
      to the locally tested DB (`scripts/rewards/schema-fingerprint.sql`, 11/11 categories)
- [x] Runtime roles `rebound_api|indexer|scheduler|verifier` (`scripts/rewards/database-roles.sql`), applied
- [x] Policy rows `rebound-v3.0` (`cf61e965…`) and `rebound-v3.0-test` (`dc12b800…`); hash re-verified in SQL
- [x] `db.cjs`: `rebound` schema, pooler-safe connection, durable row leases with fencing; advisory locks removed
      from `worker.cjs` and `launch.cjs`
- [x] `session.cjs` (Supabase Auth verification, server-controlled identities, domain-bound admin),
      `consent.cjs` (one-time action consent), `logs.cjs` (redacted, persisted-first), `storage.cjs` +
      `metadata.cjs` (immutable content-addressed Supabase Storage; Blobs read-compat)
- [x] API router `netlify/functions/rewards.cjs` with error contract (`docs/API-V3.md`)
- [x] Browser session module `src/auth/wallet-session.js` (session bound to the exact selected wallet)
- [x] Tests: `tests/rewards/supabase-access.test.cjs` (10), `tests/wallet-session.test.cjs` (3)
- [x] Live checks on the real project: anon reads only 2 projections / writes nothing; PokeDrop user is
      not admin; anonymous Realtime received INSERT+UPDATE of a public row in ~350 ms; anonymous
      subscriber to admin logs got only `Error 401: Unauthorized` without row data
- [ ] **External:** Auth → Redirect URLs `https://rebound.wtf/**`, `https://www.rebound.wtf/**`. Live
      evidence: SIWS for rebound.wtf is rejected ("URI which is not allowed on this server"). Re-run
      `.probe/web3-spike.cjs` after the change.
- [ ] **External:** `SUPABASE_SECRET_KEY` + scoped `DATABASE_URL` in Netlify env, then a live metadata upload
- [ ] **External:** admin wallet address(es) from the owner → `reward_admin_wallets`
- [ ] Rename project display name to "REBOUND" (dashboard only)

Note: this build container cannot reach `*.supabase.co` or Solana RPC (egress policy 403); live probes run
from the owner's Mac (`Desktop/Projects/Rebound/.probe/`), database changes through the Supabase MCP.

## M2 — finalized history and loss engine

- [ ] `policy-v3.cjs` formulas + tests (§19 accounting list)
- [ ] FIFO lots incl. zero-basis incoming, lot credits
- [ ] SOL/USD historical evidence module (Pyth)
- [ ] 60 s TWAP token/USD reference price
- [ ] Per-anchor cutoff snapshots; preview output with reasons
- [ ] Primary dev-wallet funding ledger (buckets, retained 15%, reconciliation from finalized events)
- [ ] Remove permanent-exit / wallet-link exclusions from the active path
- [ ] Real read-only mint history snapshot (or named coverage blocker)

## M3 — program V3 and durable funding/payouts

- [ ] `contracts/v3` state + instructions; Rust unit tests; SBF build
- [ ] LiteSVM compiled-program tests: conservation, holder-only deposit, split once, timing, replay
- [ ] `wire-v3.cjs`; verifier V3 manifest recomputation
- [ ] Scheduler state machine, leases, crash recovery
- [ ] Manual primary funding (exact transaction for owner signature) and automatic signer mode
- [ ] Rent-aware batched payouts; ambiguous broadcast reconciliation

## M4 — third-party launches and buyback/burn

- [ ] Launch flow on V3 (initial creator = intake PDA), `created_pending_activation`, resumable steps
- [ ] Per-mint buyback reserve, quote/slippage/impact validation, swap + real burn, burn-only retry
- [ ] Curve and graduated paths tested against cloned Pump programs

## M5 — admin dashboard, Privy UI, live discovery

- [ ] Privy island + Supabase session; wallet selection/rejection/disconnect/account change
- [ ] `#admin`: primary mint, dev wallet, mode, signer, start/pause/resume, preview, approve funding, retry, health, test controls
- [ ] Realtime logs panel; token list under "Find a Solana token" with Realtime updates
- [ ] Public copy updated to V3 policy
- [ ] Browser end-to-end tests

## M6 — deployment and capped mainnet acceptance

- [ ] Netlify/Supabase/worker deployment docs and configuration
- [ ] Program deployed + initialized (governed), dry run, capped `mainnet_test`
- [ ] Runbook §18.2 executed with evidence

## External setup required (no secrets in chat or repository)

| Item | Needed by | Status |
|---|---|---|
| Supabase project | M1 | **Decided**: repurpose `zuvefozubbgstyljfxjh` (Chainlets) |
| Supabase: Web3 (Solana) enabled ✓; Redirect URLs `https://rebound.wtf/**` | M1 | **pending (dashboard)** |
| Supabase secret key for Netlify (Storage uploads) and scoped DB logins | M1/M5 | pending |
| Admin wallet public addresses | M1 | **requested from owner** |
| PokeDrop cleanup approval (see LEGACY-CHAINLETS-CLEANUP.md) | any | awaiting owner |
| Privy app ID (public) + allowed origins `https://rebound.wtf`, previews, localhost | M5 | pending |
| Netlify site (historical: `tourmaline-melomakarona-72b603`) access, linked branch, env vars | M1/M5 | pending |
| Mainnet RPC (HTTP+WS) with archival history (e.g. Helius/Triton) — set in Netlify/worker env | M2 | pending |
| Primary mint (current config `3SohGcVP…ppump` is an unverified placeholder) | M2 | pending |
| Dev funding wallet public address; test holder wallets | M2/M6 | pending |
| Worker host (Docker) | M3/M6 | pending |
| Program upgrade authority / governance, publisher, verifier, guardian public keys | M3/M6 | V2 addresses recorded in `.env.example` are unverified |
| Mainnet test spending budget (explicit cap) | M6 | pending |

## Verification log

| Date | Scope | Command | Result |
|---|---|---|---|
| 2026-09-26 | Baseline JS (V2 branch) | `pnpm test` (Node 24.21, pnpm 11.19) | 57 pass, 3 skipped (protocol-capture replay needs `contracts/v2/artifact/pump-execution.json`) |
| 2026-09-26 | V2 Rust | `cargo test --locked` (contracts/v2) | 6 pass |
| 2026-09-26 | V2 SBF | `cargo build-sbf` (Agave 4.2.2, platform-tools v1.54) | built |
| 2026-09-26 | V2 compiled program | `pytest contracts/v2/tests/test_svm.py` | 18 pass |
| 2026-09-26 | Cloned Pump lifecycle | `clone-protocol.cjs` | **skipped**: needs mainnet RPC; public RPC not reachable from the build container |
| 2026-09-26 | M1 local | `pnpm test` | 70 pass, 3 skipped (same protocol-capture skips) |
| 2026-09-26 | M1 local | migrations on PostgreSQL 16.13 + emulation, single transaction | 58 tables, 0 without RLS |
| 2026-09-26 | M1 live | fingerprint local vs Supabase | identical (11 categories) |
| 2026-09-26 | M1 live | anon/authenticated RLS probe (rolled back) | anon reads 2 projections only; 0 writable; PokeDrop user not admin |
| 2026-09-26 | M1 live | Realtime probe from owner Mac | INSERT+UPDATE received ~350 ms; logs → 401 without data |
| 2026-09-26 | M1 live | SIWS for rebound.wtf | rejected: redirect URL not allowed (external step) |
