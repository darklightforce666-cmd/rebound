# Supabase setup for REBOUND

Project: `zuvefozubbgstyljfxjh` (`https://zuvefozubbgstyljfxjh.supabase.co`, eu-central-1, Pro).
Everything REBOUND lives in schema **`rebound`**, which is intentionally *not* in the Data API's
exposed schemas. Browsers read public projections through Realtime/RLS or through the Netlify API.

## 1. Migrations (versioned, additive)

Source of truth: `server/rewards/migrations/NNN_*.sql`, applied in order with
`search_path = rebound, public`. Applied to the live project (Supabase migration history names
`rebound_001_rewards` … `rebound_007_harden_functions`, `rebound_seed_policies_v3`,
`rebound_runtime_roles_v3`). Never edit an applied file; add a new one ending with
`SELECT reward_secure_new_tables();` so new tables get RLS and server policies.

Local / CI: `DB.migrate(db,{emulateSupabase:true})` against PGlite or PostgreSQL 16+ loads
`scripts/rewards/supabase-emulation.sql` (roles anon/authenticated, `auth.uid()`, `auth.identities`,
the realtime publication and `storage.buckets`). Never run the emulation against Supabase.

Fidelity check after applying: run the fingerprint query in `scripts/rewards/schema-fingerprint.sql`
on the reference database and on Supabase; every row (col, con, idx, fn, trg, rls, grant, colgrant,
pub, policy, mig) must be identical.

## 2. Roles and credentials

| Component | Database role (NOLOGIN group) | Notes |
|---|---|---|
| Netlify API | `rebound_api` | short requests; cannot write financial state or read key material |
| Indexer worker | `rebound_indexer` | finalized evidence, lots, prices, public market projection |
| Scheduler/settlement worker | `rebound_scheduler` | cycles, awards, funding, buyback; only role that can read signer ciphertext |
| Verifier | `rebound_verifier` | read + attestations |

Create one LOGIN per component (passwords from a secret manager; never in chat or git):

```sql
CREATE ROLE rebound_api_login LOGIN PASSWORD '<secret>' IN ROLE rebound_api;
ALTER ROLE rebound_api_login SET search_path = rebound, public;
-- repeat for rebound_indexer_login, rebound_scheduler_login, rebound_verifier_login
```

Connection strings (Supavisor): transaction pooler `…pooler.supabase.com:6543` for the Netlify API;
session pooler `:5432` or direct connection for workers. User format `rebound_api_login.zuvefozubbgstyljfxjh`.
No component relies on session state: coordination uses `reward_leases` row leases with fencing.

The Supabase **secret key** (`sb_secret_…`) is used only by the Netlify API for Storage uploads
(`SUPABASE_SECRET_KEY`), never in the browser, never for database access.

## 3. Auth (Web3 / Sign in with Solana)

- Provider: Web3 → Solana enabled (already enabled on this project).
- **URL configuration → Redirect URLs must include** `https://rebound.wtf/**` and
  `https://www.rebound.wtf/**` (plus preview/local origins used for testing). Without them Supabase
  rejects the SIWS message: live evidence 26 Sep 2026 — *"Signed Solana message is using URI which is
  not allowed on this server"*.
- Admins are bootstrapped out of band (SQL as schema owner), never from the browser:

```sql
INSERT INTO rebound.reward_admin_wallets(wallet,label,added_by) VALUES('<address>','owner','bootstrap');
-- extra sign-in domains (e.g. a Netlify preview) must be added explicitly:
INSERT INTO rebound.reward_allowed_auth_domains(domain,note) VALUES('<host>','preview');
```

## 4. Realtime

Published: `reward_public_tokens`, `reward_public_cycles` (anon-readable), `reward_logs`,
`reward_health` (admin-only via RLS), `reward_launch_attempts` (owner-only).
Live evidence 26 Sep 2026: an anonymous subscriber received INSERT/UPDATE of a public token row
~350 ms after commit (revision 1→2); an anonymous subscriber to `reward_logs` received only
`{"new":{},"errors":["Error 401: Unauthorized"]}` (no row data). Residual disclosure: the *existence*
of a log event is visible; content is not. Clients subscribe with `schema:'rebound'`.

## 5. Storage

- `rebound-token-assets` — public read, 2 MB, PNG/JPEG/JSON; content-hash names
  (`images/<sha256>.png`, `metadata/<sha256>.json`); uploads with `x-upsert:false`; no browser write
  policies. URLs are stable and do not expire.
- `rebound-evidence` — private, JSON manifests/evidence.
- Legacy V2 URIs `/.netlify/functions/rewards?action=metadata|image&hash=` remain served from
  Netlify Blobs by the compatibility endpoint.

## 6. Backup / restore

Pro plan daily backups plus a logical dump before any destructive change:
`pg_dump --schema=rebound -Fc -f rebound-$(date +%F).dump "$OWNER_DB_URL"` and
`pg_restore --no-owner -d "$TARGET_DB_URL" rebound-<date>.dump`, then re-run
`scripts/rewards/database-roles.sql`. The restore test (M6) must show jobs, receipts, funding credits,
chain attempts and idempotency keys preserved.
