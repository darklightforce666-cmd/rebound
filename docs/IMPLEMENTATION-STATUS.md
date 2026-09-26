# REBOUND V3 — implementation status

Specification: `REBOUND_IMPLEMENTATION_SPEC_EN.md` v1.0 (owner-supplied, 26 Sep 2026).
Decisions: [POLICY-V3.md](POLICY-V3.md) · Module plan: [V3-MODULE-PLAN.md](V3-MODULE-PLAN.md)

## Branches

| Branch | Commit | Role |
|---|---|---|
| `main` | `648956847fd94ee9cb4fd0217777467991f07608` | Older frontend + V1; untouched |
| `rewards-v2-implementation` | `c7bde3e18a6b695650e14e3c26a6b0a856f0f3f3` | Baseline; untouched |
| `rebound-v3-implementation` | (this branch) | All V3 work (repository made public by the owner on 2026-09-26 so Netlify's Personal plan builds branch deploys; history scanned: no secrets) |

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

## M1 — Supabase, authentication, data boundaries — implemented; admin wallets pending

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
- [x] Auth → Redirect URLs `https://rebound.wtf/**`, `https://www.rebound.wtf/**` added (PokeDrop URLs and
      Site URL left unchanged). Live SIWS for rebound.wtf now succeeds (identity `web3:solana:…`, domain
      `rebound.wtf`, `/auth/v1/user` 200; the throwaway user is not admin).
- [x] Netlify env (site `tourmaline-melomakarona-72b603`, builds stopped): `SUPABASE_URL`,
      `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (new dedicated key `rebound_netlify`, secret,
      pasted via clipboard — never displayed), `REWARDS_MAX_EXECUTION_MODE=dry_run`, `DATABASE_URL` →
      scoped login `rebound_api_login` (member of `rebound_api`, SCRAM verifier generated on the owner's
      Mac, transaction pooler `aws-0-eu-central-1:6543`; verified: reads projections, writes refused).
      `SOLANA_RPC_URL` already held the owner's Alchemy endpoint (archival, v1 transactions verified).
- [ ] **External:** admin wallet address(es) from the owner → `reward_admin_wallets`
- [x] Project display name renamed to "REBOUND" (ref/API URL unchanged)

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

## M4 — third-party launches and buyback/burn — implemented; verified on cloned mainnet programs

- [x] `pump-v3.cjs` (official `@pump-fun/pump-sdk@2.0.0` / `pump-swap-sdk@1.20.0`): launch = V3 `PrepareCoin` +
      `create_v2` with the per-mint intake PDA as creator (regular creator-fee coin; holder-reward, mayhem,
      cashback and non-SOL refused); the creator's initial buy goes in the same transaction when it fits,
      otherwise as a second transaction (the intake is already the creator, so no fee escapes)
- [x] Routing: fee-sharing create (setup rent moved from the user to the intake first) + lock (admin revoked,
      intake = sole 100 % shareholder) signed by the intake PDA inside the program; `verifyRouting` checks
      curve creator, sharing config, coin account and (after graduation) the canonical pool before `active`
- [x] `launch-v3.cjs` + API (`launch-draft/prepare/submit/status`, `activation-prepare/submit`): browser mint key,
      exact transactions verified against stored intents, simulation before signing, coin persisted only after
      finalized evidence, `created_pending_activation` survives rejected/closed setup, resume offers only the
      steps the chain still lacks, a creation that can still land blocks replacement (no duplicate token);
      launches obey the namespace execution mode and test allowlist
- [x] `receipts-v3.cjs`: permissionless collection crank; intake scan credits only transfers from the coin's
      Pump creator vaults (setup rent/donations recorded as non-income); verifier re-measures each finalized
      collection and signs the receipt; `Credit` with receipt-PDA settlement; split mirrored once in the ledger
- [x] `buyback-v3.cjs`: one job per coin and cycle, target mint/config frozen at reservation; quote on the
      canonical market only (curve `buy_exact_sol_in`, pool `buy_exact_quote_in`), min_out/impact/quote-age
      checks, `deferred` with budget kept reserved on any failure; one signed purchase followed through
      ambiguous broadcasts; burn-only retry; `burn_checked` verified by supply delta; close returns unspent
      budget to the buyback reserve (never to holders)
- [x] Worker wiring: indexer scans intakes; scheduler cranks collections, credits receipts and advances buyback
      jobs for every active third-party coin
- [x] Program: unspent WSOL unwrapped after a PumpSwap buyback (sha256 `3e169837…`)
- [x] Live-verified protocol facts, fixed in code: v1 transactions; Pump `create_v2` mint rent fails for very
      short metadata (creation is simulated before the user signs); fee-sharing setup rent paid by the creator;
      PumpSwap picks fee recipients at random (REBOUND fixes them); protocol WSOL accounts and volume
      accumulators are created by the operations payer, not from the buyback budget; the 23-account PumpSwap
      route fits a legacy transaction only with the publisher as fee payer
- [ ] Live mainnet evidence → M6 runbook

Tests: `pump-lifecycle-v3` (4), `third-party-v3` (2), `launch-v3` (3) run the real Pump / PumpSwap / fee binaries
cloned from mainnet (`scripts/rewards/clone-protocol.cjs contracts/v3/fixtures/mainnet`; fixtures git-ignored).

## M5 — admin dashboard, Privy UI, live discovery — implemented; live wallet check pending Privy App ID

- [x] Privy island (`src/privy-island.js` → `dist/src/privy.js`, loaded only when `PRIVY_APP_ID` is set): Solana
      external wallets only, no Privy login/embedded wallets; the selected wallet signs SIWS for the Supabase
      session and exact transactions; injected-wallet fallback without an app id
- [x] `#admin` (admin = unrevoked wallet in `reward_admin_wallets` + allowed sign-in domain): status/health,
      execution mode (production locked by `REWARDS_ALLOW_PRODUCTION`), private-test allowlists/caps, pause,
      primary registration (dev wallet proven in the session), opening credit, manual funding approval, on-chain
      governance actions (prepared, simulated, signed by the admin wallet, verified before broadcast), coins,
      rounds, receipts, buyback/burn, administrators; consent-signed mutations
- [x] Realtime logs panel; token list under "Find a Solana token" with Realtime updates; wallet awards
- [x] Launch journey (draft → prepare → sign → status → activation) against the V3 API
- [x] Public copy updated to the V3 policy (underwater holdings, split once, buy-and-burn)
- [x] Browser smoke (`tests/browser/smoke-v3.cjs`, Playwright/Chromium): every route on desktop and mobile, no
      page errors, no horizontal overflow
- [ ] Live wallet flows with Privy on the deployed preview (needs `PRIVY_APP_ID` and a wallet extension)

## Admin launch panel (owner request, 2026-09-26)

- [x] `#admin` → **Launch**: token contract + dev fee wallet (+ namespace); switchable at any time (previous primary /
      wallet retired only when no round is in progress); checklist (token on mainnet, program deployed, registered on
      chain, worker online, payouts live); **Site access** (open / password); **Privy App ID**; live **Logs** on top;
      technical sections under *Advanced*
- [x] `reward_site` (migration 011, applied live): public settings row, Realtime; API-only writes (admin + consent)
- [x] Site follows the setting live: password gate skipped when open; token card name + copy-on-click address and
      the chart switch to the configured mint without reload (Realtime, 60 s poll fallback)
- [x] Password access to `#admin` (migration 012, applied live): scrypt hash, HMAC sessions (12 h, bound to
      `session_version`), 5 wrong attempts → 15 min lock + per-IP rate limit; first password via a one-time setup code
      (only its SHA-256 stored; code delivered to the owner's Mac, 7-day expiry); change password (signs out other
      sessions); **Administrator wallet** set/replaced from the dashboard; password sessions approve dashboard changes
      but never sign Solana transactions
- [x] Privy App ID set (site settings)
- [ ] Owner: create the password with the setup code; set the admin wallet; enter the real token mint

## Third-party token test mode (owner request, 2026-09-27)

- [x] Program: payout receipts are a bitmap inside the round account (was one 0.0018-SOL `Paid` account per
      recipient); `Pay` has no signer; new `CloseRound` (tag 21) returns the round rent to its funder once every
      award is paid. Release artifact rebuilt: 210 848 bytes, sha256 `2298cf58…`. `cargo test` 9, LiteSVM 12 pass.
- [x] Policy v3.1 (`rebound-v3.1`, `rebound-v3.1-test`): losses in **SOL**, no SOL/USD dependency, so every holder
      with a recorded purchase is counted. v3.0 (USD) kept for history; unused namespaces move to v3.1 on seed.
- [x] Balance budget (migration 013): the fee wallet commits a share (default 50 %) of its **current** balance,
      measured once by the scheduler (finalized); rounds deposit only what is left (on-chain deposit counter),
      keeping 0.01 SOL in the wallet; income reconciliation skipped for budget wallets.
- [x] Private test on strangers' tokens: `test_any_recipient` (mint allowlist + all caps still apply); Launch sets
      the allowlist, the flag and caps from the budget; real payouts only when the owner ticks *Start real payouts*.
- [x] Key inbox: the dashboard encrypts the fee-wallet key in the browser to the worker's X25519 key
      (HKDF-SHA256 + AES-256-GCM, bound to wallet row, address and worker key); API stores ciphertext only (API and
      indexer cannot read it back); the scheduler checks the key is exactly the fee wallet's, re-encrypts it under
      the signer master key, switches the wallet to automatic deposits and wipes the inbox row.
- [x] Launch checklist shows the on-chain step still missing (register / start / set fee wallet) with a one-click
      admin-wallet signature.
- [ ] Owner: deploy + initialize (test mode), launch the chosen token, import the fee-wallet key, run the worker.

## M6 — deployment and capped mainnet acceptance — tooling done and rehearsed; mainnet run waits for the owner

- [x] Release artifact `contracts/v3/release/` (SBPF v0, now sha256 `2298cf58…` — bitmap payouts; previously `3e169837…`, BUILD.md with the SIMD-0500 finding:
      mainnet still requires v0–v2; local validators need `--deactivate-feature B8JJXC…`)
- [x] `keygen-v3.cjs` (operator keys, files 600/700, public output only); `governance-v3.cjs` (status,
      initialize, set-target, register/start-primary, set-funding-wallet, pause/request-resume/resume; simulate
      first, `--dry`); `db-login.cjs` (SCRAM verifier SQL, password only in a 600 URL file)
- [x] Worker: role-scoped DB connections (indexer-only holds no scheduler/verifier login), `*_DATABASE_URL_FILE`,
      signing preflight (genesis, deployment publisher/verifier, published policy) re-checked every minute,
      `worker:scheduler` heartbeat; `Dockerfile.rewards` runs `worker-v3.cjs`; `compose.rewards.yml` (indexer,
      scheduler under profile `settle`, read-only root, secrets mounted read-only); `.env.worker.example`
- [x] **Gap fixed:** a registered primary never became `active` in the database after on-chain StartPrimary.
      The scheduler now activates it only when the finalized coin account agrees on kind, policy and dev wallet
      (`admin-v3.syncPrimary`, tested on the compiled program)
- [x] **SOL/USD freshness:** with `PYTH_API_KEY` the indexer samples Hermes (fresh) and backfills purchase
      times from Benchmarks; without it only the on-chain feed (~53 s cadence vs the 30 s policy limit) is used
- [x] Rehearsal on a mainnet-equivalent local validator: deploy (bytes verified), initialize test-mode,
      set-target, register-primary, start-primary, pause → request-resume → resume refused (24 h), worker roles
      with least-privilege logins, preflight pass/fail
- [x] `docs/MAINNET-TEST-RUNBOOK.md`: budget, commands, dry run, capped test, evidence, rollback
- [x] Independent review of M5/M6 (separate agent, no prior context) — fixed:
      **high:** dev-wallet funding reconciliation ran under the indexer login, which cannot write funding
      ledgers (primary rounds could never have been funded live) → moved to the scheduler; holder deposits are
      now recognized from the finalized `DepositHolders` instruction, not from database labels; reconciliation
      stops at an unreadable transaction or partial listing instead of skipping it.
      **medium:** API role could rewind `spent_total_lamports` / opening-credit columns → migration 010
      (monotonic spend for service roles, opening columns scheduler-only; applied live).
      **low:** SQL errors redacted (409 `CONFLICT` / 503), production primary registration gated and an active
      primary not replaceable, governance submit bound to the preparing admin, SOL/USD backfill no longer
      retries the same times every loop, consent display lines derived from the hashed payload.
      Not changed: receipt guard (009) does not freeze `state` against a compromised indexer login (noted)
- [x] Netlify branch deploy `rebound-v3-implementation--tourmaline-melomakarona-72b603.netlify.app` (behind Netlify team login): API live against Supabase (`health`, `config`, `tokens` 200; admin 401 without session); first build crashed on `bigint-buffer` (native module omitted by Netlify's packager) → vendored pure-JS shim, verified with `@netlify/zip-it-and-ship-it`
- [ ] Production publish (merge to `main`, 15 credits per production deploy) after the owner's OK
- [ ] Program deployed + initialized on mainnet, dry run, capped `mainnet_test` (runbook §3–§8) with evidence

## External setup required (no secrets in chat or repository)

| Item | Needed by | Status |
|---|---|---|
| Supabase project | M1 | done: `zuvefozubbgstyljfxjh`, renamed REBOUND |
| Supabase: Web3 (Solana) enabled; Redirect URLs rebound.wtf + www | M1 | done; SIWS verified live |
| Supabase secret key for Netlify; scoped DB logins | M1/M5 | API: done (`rebound_netlify` key, `rebound_api_login`); worker logins (indexer/scheduler/verifier) with the worker host |
| Admin wallet public addresses | M1 | **requested from owner** |
| PokeDrop cleanup approval (see LEGACY-CHAINLETS-CLEANUP.md) | any | awaiting owner |
| Privy app ID (public) + allowed origins `https://rebound.wtf`, previews, localhost | M5 | pending |
| Netlify site `tourmaline-melomakarona-72b603` env vars | M1/M5 | V3 vars set (dry_run ceiling); builds active with branch deploys for `rebound-v3-implementation` only (production branch `main` unchanged); `DATABASE_URL`/`SOLANA_RPC_URL` also set for branch deploys; `ALLOWED_ORIGINS` = preview origin; Supabase redirect URL added for the preview |
| Mainnet RPC with archival history | M2 | done: owner's Alchemy endpoint (archival + v1 verified); worker env with the worker host |
| Primary mint (current config `3SohGcVP…ppump` is an unverified placeholder) | M2 | pending |
| Dev funding wallet public address; test holder wallets | M2/M6 | pending |
| Worker host (Docker) | M3/M6 | pending (compose + env template ready) |
| Pyth API key for the worker (`PYTH_API_KEY`) | M6 | optional since policy v3.1 (losses in SOL); only used for USD display |
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
| 2026-09-26 | M4 cloned protocol | lifecycle/third-party/launch suites on cloned Pump, PumpSwap, fee programs | 9 pass |
| 2026-09-26 | M4 local | `pnpm test` | 132 pass, 3 skipped (same) |
| 2026-09-26 | M4 live | migration 009 + API grants on Supabase | applied; no REBOUND advisor findings |
| 2026-09-26 | M1 live | SIWS sign-in for https://rebound.wtf after redirect URLs | ok; identity domain rebound.wtf; not admin |
| 2026-09-26 | M1 live | `rebound_api_login` via transaction pooler from owner Mac | connects; search_path rebound; forbidden write refused |
| 2026-09-26 | M3 Rust | `cargo test --locked` (contracts/v3) | 8 pass |
| 2026-09-26 | M3 SBF + compiled | `cargo build-sbf`; `pytest contracts/v3/tests` (LiteSVM + wire parity) | built `ad180f2a…`; 12 pass |
| 2026-09-26 | M3 local | `pnpm test` (incl. 5 end-to-end cycle tests on the compiled program, 5 worker tests) | 126 pass, 3 skipped (same) |
| 2026-09-26 | M3 local | migrations 001–008 on PostgreSQL 16 (fresh DB) | version 8, RLS on new table |
| 2026-09-26 | M3 live | migration 008 + API grants on Supabase | applied; RLS on, 6 role grants |
| 2026-09-26 | M3 skipped | Pump swap CPI with cloned programs | M4 (needs cloned mainnet accounts) |
| 2026-09-26 | M6 rehearsal | `solana-test-validator` 4.2.2 with SIMD-0500 deactivated: deploy + governance-v3 sequence | deployed bytes = `3e169837…`; programdata rent 2.0892 SOL (max-len 300000); all actions finalized; resume refused before 24 h |
| 2026-09-26 | M6 local | worker `--once` per role with `rebound_{indexer,scheduler,verifier}_login` | indexer ok; scheduler ok with matching genesis, `down` (preflight: wrong network) otherwise |
| 2026-09-26 | M6 local | `db-login.cjs` SCRAM verifier on PostgreSQL 16 with `scram-sha-256` auth | create + rotate; generated URL logs in; wrong password refused |
| 2026-09-26 | M6 local | `pnpm test` after review fixes | 150 tests: 147 pass, 3 skipped (protocol-capture replay, as before) |
| 2026-09-26 | M6 local | migrations 001–010 on a fresh PostgreSQL 16 + `database-roles.sql` | version 10; API cannot update opening columns; indexer cannot write funding ledgers |
| 2026-09-26 | M6 live | migration 010 on Supabase | applied; privileges verified; no advisor findings in schema `rebound` |
| 2026-09-26 | M6 preview | Netlify branch deploy `a0d5132`, requests from an authenticated browser | health/config/tokens 200 (dry_run, worker offline, no primary); admin-overview 401; `pnpm test` 151 tests: 148 pass, 3 skipped |
| 2026-09-26 | Admin launch panel | `pnpm test`; browser render with mocked wallet/session/API; migration 011 live | 154 tests: 151 pass, 3 skipped; gate skipped when open; panel renders desktop/mobile, no overflow; anon read-only, RLS on, Realtime on |
| 2026-09-27 | Admin password | `pnpm test`; browser render of sign-in → dashboard (mocked API); migration 012 live | 158 tests: 155 pass, 3 skipped; anon cannot read reward_admin_auth |
