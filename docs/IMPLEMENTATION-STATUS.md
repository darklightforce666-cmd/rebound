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

## M2 — finalized history and V3 loss engine — implemented; live read-only run pending

- [x] `policy-v3.cjs` formulas: split once with per-mint carry, FIFO proportional consumption, position
      Q/C/V/K/L with profitable-lot offset, allocation with loss caps and deterministic rounding,
      credit→lot attribution, schedule (1800/60; test 120/30), 60 s TWAP `max(spot,twap)` with named holds
- [x] `lots-v3.cjs`: trade↔delivery matching per transaction, payment proof from the buyer's own transfers,
      zero-basis gifts/owner changes/router intermediaries/side pools, FIFO outflows, post-balance proof
      after every transaction, credit replay at snapshot slots (transfer out/back cannot reset credit)
- [x] `sol-usd.cjs`: Pyth Benchmarks (needs `PYTH_API_KEY`, required by Pyth since 2026-08-26) and
      on-chain Pyth feed (live `PriceUpdateV2` + update-transaction history); age ≤ 30 s, conf ≤ 1 %
- [x] `primary-funding.cjs` + `funding-store.cjs`: per-transaction dev-wallet reconciliation, opening credit
      once, 85/15 split once, retained 15 % never re-split, holder-only deposits, fees → operating,
      insufficient backing → exact shortfall incident + coin paused; DB CHECK enforces conservation
- [x] `history-v3.cjs`: mint-scoped finalized history (mint, curve, pool + every discovered token account),
      exact in-block order, honest coverage; `findCutoffSlot`; `mint-v3.cjs` (Token-2022 extension gate)
- [x] `snapshot-v3.cjs`: deterministic snapshot + round proposal, `waiting_for_data` with exact reason
- [x] Parser `rebound-execution-v3.0`; V2 permanent exits/wallet links removed from the active path
- [x] `scripts/rewards/preview-v3.cjs`: read-only auditable preview report
- [x] **Live (26 Sep, owner Mac, public mainnet RPC):** `preview-v3.cjs` on a live Pump mint
      (`Goreaw…Lpump`, Token-2022, created ~15:1x UTC): history **complete** — 88 addresses, 205 finalized
      transactions (4 failed, excluded), 1 368 events (105 purchases, 66 sales, 132 transfers, 200 post-balance
      proofs), **0 parser holds**; cutoff slot resolved exactly. First run found v1 transactions (fixed, see M3).
      Snapshot correctly held `waiting_for_data: sol_usd_window_incomplete` — no FX evidence (below).
- [ ] **Decision/config — SOL/USD source (measured live):** the sponsored on-chain Pyth SOL/USD account
      (`7UVimf…`, receiver-owned, decoder verified on real `UpdatePriceFeed` txs) is updated about every
      **53 s**, so the policy's 30 s max age cannot be met from it, and historical backfill on-chain is not
      practical (the account's signature list is dominated by readers: 1 000 signatures ≈ 6 min; updates
      are ~1 in 120 of the updater's transactions). Options: **(a) `PYTH_API_KEY`** (Benchmarks/Hermes;
      keeps the published 30 s / 1 % policy; recommended), or (b) on-chain only with a policy change
      (e.g. max age 90 s → new policy hash) plus holds for purchases before the worker started recording.
- [ ] Primary mint (placeholder `3SohGc…pump` unverified) — needed for the real primary preview

## M3 — program V3 and durable funding/payouts — implemented locally; deployment is M6

- [x] `contracts/v3` (solana-program 2.2.1, seeds `*-v3`, magics `RBD3*`), commands 0–20: Initialize (upgrade
      authority check), RegisterPrimary/StartPrimary/SetFundingWallet, **DepositHolders** (primary, holder-only,
      never split), PrepareCoin/CreateSharing/LockSharing/Activate, **Credit** (third-party, verifier Ed25519
      attestation, split 85/15 once into holder/buyback), **Fund** (publisher + verifier, only inside
      `[cutoff(n), cutoff(n+1))`), **Pay** (permissionless after due time, Merkle-sum proof + paid-receipt PDA, no
      fresh holding check), Pause/RequestResume/Resume (delayed), SetAuthorities (paused only),
      SetBuybackTarget/ReserveBuyback/BuybackSwap (Pump `buy_exact_sol_in` / PumpSwap `buy_exact_quote_in` CPI via a
      per-job buyer PDA)/BuybackBurn (`burn_checked`, verified by supply delta; burn-only retry)/CloseBuyback.
      Build: `cargo build-sbf` → `target/deploy/rebound_rewards_v3.so` sha256 `ad180f2a3e407cca…`
- [x] Compiled-program tests (LiteSVM): conservation, holder-only deposit, split once, Fund window, due-time
      Pay, replay refusal, pause/resume delay, authorities; JS↔Rust wire parity vectors
- [x] `wire-v3.cjs`; `verifier-v3.cjs` recomputes the snapshot from its own DB role, rebuilds the manifest and
      co-signs only an exactly matching single Fund instruction
- [x] `cycle-v3.cjs`: durable state machine (scheduled → snapshotting → [waiting_for_data] →
      awaiting_funding_signature | funding_pending → funded → paying → complete / partially_paid / expired …),
      row leases with fencing, policy-hash agreement (DB = on-chain coin), crash/ambiguous-broadcast recovery
- [x] `transport-v3.cjs` + `execution.cjs`: persist signed bytes before broadcast, reconcile by on-chain
      receipts, rebroadcast identical bytes only; execution gate `dry_run`/`mainnet_test`/`production` under the
      host ceiling `REWARDS_MAX_EXECUTION_MODE`, allowlists and spend caps
- [x] Automatic signer mode (`signer.cjs`, AES-256-GCM at rest, master key file chmod 600; `import-signer.cjs`)
- [x] **Manual funding**: `GET funding-plan` returns the exact holder-only deposit for the registered dev wallet
      (blockhash refreshed when stale); `POST funding-submit` verifies the signed bytes against the plan, gates,
      persists, broadcasts (API role); the scheduler moves the cycle, follows the signature and hands the plan
      back to the owner if it expires unlanded; an unsigned plan expires at the next cutoff with no credit
- [x] Rent-aware payouts: awards below rent-exempt minimum stay `deferred_rent` liabilities
      (`partially_paid`) until `REWARDS_SPONSOR_RENT` or a later funding covers the rent
- [x] `worker-v3.cjs`: incremental mint-scoped ingestion with per-address cursors (migration 008, applied
      live), exact in-block order (RPC `transactionIndex`, `getBlock` fallback), cursors never pass an
      unavailable transaction, coverage checkpoints; snapshot evidence loader shared by scheduler and verifier;
      on-chain SOL/USD sampler, finalized curve/pool heartbeats, dev-wallet reconciliation (REBOUND deposits are
      liability moves, never new funding), public token projection. Run: `node server/rewards/worker-v3.cjs`
      (`REWARDS_WORKER_ROLE=indexer|scheduler|all`, `--once`)
- [x] **Live finding fixed:** mainnet now carries **version-1 transactions**; requesting
      `maxSupportedTransactionVersion:0` made the RPC refuse them (-32015). All V3 history/SOL-USD reads request
      v1 (jsonParsed shape unchanged for the fields used). Legacy V2 modules using web3.js
      `getParsedTransaction` cannot read v1 and are not on the V3 path.
- [ ] Buyback swap CPI against real Pump/PumpSwap programs (cloned accounts) → M4
- [ ] Program deployment + initialization under governance → M6

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
| 2026-09-26 | M2 local | `pnpm test` | 114 pass, 3 skipped (same) |
| 2026-09-26 | M2 live | `preview-v3.cjs` on a live Pump mint (owner Mac, public RPC) | history complete, 1 368 events, 0 parser holds; held on SOL/USD (expected without FX source) |
| 2026-09-26 | M2 live | on-chain Pyth SOL/USD cadence probe | live read OK ($121.63); updates ~53 s apart; update-tx decoder verified |
| 2026-09-26 | M3 Rust | `cargo test --locked` (contracts/v3) | 8 pass |
| 2026-09-26 | M3 SBF + compiled | `cargo build-sbf`; `pytest contracts/v3/tests` (LiteSVM + wire parity) | built `ad180f2a…`; 12 pass |
| 2026-09-26 | M3 local | `pnpm test` (incl. 5 end-to-end cycle tests on the compiled program, 5 worker tests) | 126 pass, 3 skipped (same) |
| 2026-09-26 | M3 local | migrations 001–008 on PostgreSQL 16 (fresh DB) | version 8, RLS on new table |
| 2026-09-26 | M3 live | migration 008 + API grants on Supabase | applied; RLS on, 6 role grants |
| 2026-09-26 | M3 skipped | Pump swap CPI with cloned programs | M4 (needs cloned mainnet accounts) |
