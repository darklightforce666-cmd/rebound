# REBOUND API contract (V3)

Endpoint: `/.netlify/functions/rewards?action=<action>` (Netlify Functions, Node 24, CommonJS).
Implementation: `netlify/functions/rewards.cjs`. Background work (indexing, snapshots, settlement,
buyback) runs in the worker, never in a function request.

## Conventions

- JSON bodies; big integers (lamports, raw token units, usd_pico = 10⁻¹² USD) are **decimal strings**.
- Errors: `{code, message, retryable, requestId, jobId?}` with codes `UNAUTHORIZED`, `FORBIDDEN`,
  `NOT_FOUND`, `INVALID_BODY`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `SETUP_REQUIRED`, `MINT_INVALID`,
  `HISTORY_INCOMPLETE`, `PRICE_STALE`, `FUNDING_SIGNATURE_REQUIRED`, `INSUFFICIENT_BACKING`,
  `TRANSACTION_UNCERTAIN`, `BUYBACK_ROUTE_UNAVAILABLE`, `STORAGE_UNAVAILABLE`, `AUTH_UNAVAILABLE`, `UNAVAILABLE`.
- Mutations (POST): `Origin` must be `PUBLIC_SITE_ORIGIN` or listed in `ALLOWED_ORIGINS`; body ≤ 3 MB;
  per-IP rate limit; `Authorization: Bearer <Supabase access token>` verified with Supabase Auth.
- Signed consent: wallet-bound actions carry `{wallet, payload, proof:{id, signature}}` where the
  proof signs a one-time message from `consent-challenge` (binds user, wallet, domain, action,
  payload hash, nonce, 120 s expiry, and where relevant mint/policy/funding mode/target primary mint).
  A consent never authorizes spending; SOL moves only by separately signed transactions.
- Browsers never supply eligibility, amounts, fees, roles or instructions.

## Implemented (M1)

| Method | Action | Auth | Result |
|---|---|---|---|
| GET | `config` | public | site, Supabase URL + publishable key, Privy app id, effective policy (version, hash, 85/15, 1800/60 s, USD loss unit), namespaces (execution mode, primary mint, paused), feature flags |
| GET | `health` | public | `available`, `state` (`setup_required`/`ok`/`paused`/`worker_offline`), execution modes, worker heartbeat |
| GET | `tokens` | public | `{tokens, next, namespace}`; `view=test` for the TEST namespace; `cursor`, `limit ≤ 50` |
| GET | `token&mint=` | public | sanitized card + last 20 public cycles |
| GET | `admin-logs` | admin | filters `mint, cycle, severity, component, search, before`; 100 per page |
| GET | `admin-health` | admin | all component heartbeats |
| GET | `metadata|image&hash=` | public | legacy V2 content-addressed objects (Netlify Blobs), hash-verified |
| POST | `session` | user | `{userId, wallets, reboundWallets, admin}` (server-derived) |
| POST | `consent-challenge` | user | `{id, message, expires}` for `{wallet, action, payload, binding}` |
| GET | `funding-plan&mint=` | user linked to the registered funding wallet | `{plan}` or `{plan:null}`: `{intentId, cycle, signer, amountLamports, holderOnly:true, expiresAt, lastValidBlockHeight, transaction}` — the unsigned holder-only `DepositHolders` transaction (fee payer = dev wallet); the blockhash is refreshed when stale. `403 FORBIDDEN` for any other wallet |
| POST | `funding-submit` | user linked to the funding wallet; the wallet's transaction signature is the authority | body `{mint, intentId, signedTransaction}` (base64). Verified byte-for-byte against the stored plan (program, accounts, data, signer, blockhash; compute-budget instructions tolerated), passed through the execution gate, persisted, then broadcast → `{state: submitted|uncertain|finalized|dry_run|blocked, signature, code}`. The scheduler moves the cycle to `funding_pending`, follows the signature, and returns the plan to the owner if it expires unlanded. `409 PLAN_STALE`/`PLAN_EXPIRED`, `400 INVALID_TRANSACTION` |
| POST | `metadata-upload` | user + consent | validated image/metadata stored immutably in Supabase Storage → `{hash, uri, image, data}` |

## Planned (later milestones; same conventions)

| Action | Milestone | Auth |
|---|---|---|
| `wallet-history` | M2/M5 | public (chain-derived) |
| `admin-register-primary`, `admin-preview`, `admin-connect-funding-wallet`, `admin-set-mode`, `admin-start`/`pause`/`resume`, `admin-retry`, `admin-test-config` | M2–M5 | admin + consent |

## Administrator endpoints (M5)

All require a Supabase session whose REBOUND-domain wallet is an unrevoked admin. Mutations additionally
require a one-time consent signed by that admin wallet for the exact `payload`
(`POST consent-challenge` → sign → `POST <action> {wallet, payload, proof}`).

| Method | Action | Payload | Effect |
|---|---|---|---|
| GET | `admin-overview` | — | platform rows, coins, funding wallets/accounts, cycles, receipts, buyback jobs, health, admins, signer public fields, on-chain deployment state, host ceiling |
| POST | `admin-set-mode` | `{namespace, mode, reason}` | `production` refused unless the host sets `REWARDS_ALLOW_PRODUCTION=true`; namespace/mode pairs enforced |
| POST | `admin-test-config` | `{namespace, mints[], wallets[], capAction, capCycle, capTotal, slippageBps, impactBps}` | private-test allowlists and spend caps (action ≤ cycle ≤ total) |
| POST | `admin-pause` / `admin-resume` | `{namespace, reason}` | platform pause (all REBOUND-signed spends refused) |
| POST | `admin-register-primary` | `{namespace, mint, fundingWallet}` | primary coin + dev wallet (manual mode); the dev wallet must be a verified wallet of the same session |
| POST | `admin-opening-credit` | `{mint, requestedCreditLamports, operationalReserveLamports}` | records a request; the scheduler applies it once against the finalized dev-wallet balance |
| POST | `admin-add-admin` / `admin-revoke-admin` | `{wallet, label}` | at least one admin remains; you cannot revoke yourself |
| POST | `admin-program-prepare` | `{wallet, action, params}` | exact unsigned governance transaction (`initialize`, `setBuybackTarget`, `registerPrimary`, `startPrimary`, `setFundingWallet`, `pause`, `requestResume`, `resume`), simulated first |
| POST | `admin-program-submit` | `{intentId, signedTransaction}` | byte-for-byte check against the prepared intent, persisted, broadcast |

Public: `GET wallet-rewards&wallet=` → the wallet's fixed awards with payment evidence.
Launch journey: `launch-draft`, `launch-prepare`, `launch-submit`, `GET launch-status&id=`, `activation-prepare`, `activation-submit` (see `server/rewards/launch-v3.cjs`).
