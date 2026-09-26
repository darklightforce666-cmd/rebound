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

## M1 — Supabase, authentication, data boundaries

- [ ] Migration `005_v3.sql` (additive schema for V3 ledger, lots, cycles, credits, buyback, logs, roles)
- [ ] Migration `006_supabase_access.sql` (RLS on every table, public projections, admin-log policy, Realtime publication, Storage buckets)
- [ ] `db.cjs`: pooler-safe row leases; no session advisory locks
- [ ] Supabase JWT verification + server-controlled roles in Netlify functions; admin bootstrap script
- [ ] Web3 wallet sign-in spike (Supabase `signInWithWeb3`, exact wallet adapter)
- [ ] Metadata/images → Supabase Storage with stable immutable URLs; Blobs read compatibility
- [ ] Structured redacted logs (`logs.cjs`)
- [ ] Unauthorized-access tests (anon/creator/admin) against local Postgres with Supabase roles
- [ ] Apply to the real Supabase project and verify RLS + Realtime publish

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
| Supabase project for REBOUND (only project visible: "Chainlets", eu-central-1) | M1 | **Decision needed** |
| Supabase: Auth Web3 (Solana) provider enabled, site URL `https://rebound.wtf` | M1 | pending |
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
