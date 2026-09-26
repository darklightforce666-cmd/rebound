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
| POST | `metadata-upload` | user + consent | validated image/metadata stored immutably in Supabase Storage → `{hash, uri, image, data}` |

## Planned (later milestones; same conventions)

| Action | Milestone | Auth |
|---|---|---|
| `wallet-history` | M2/M5 | public (chain-derived) |
| `admin-register-primary`, `admin-preview`, `admin-connect-funding-wallet`, `admin-set-mode`, `admin-start`/`pause`/`resume`, `admin-retry`, `admin-test-config` | M2–M5 | admin + consent |
| `admin-funding-prepare` / `admin-funding-submit` (manual mode: exact transaction for the dev wallet to sign) | M3 | admin + funding-wallet signature |
| `launch-draft`, `launch-prepare`, `launch-submit`, `launch-resume`, `activation-prepare`, `activation-confirm` | M4 | draft owner + consent |
