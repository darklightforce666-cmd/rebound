# Supabase project `zuvefozubbgstyljfxjh` — legacy inventory and proposed cleanup

Owner decision (26 Sep 2026): repurpose the existing Pro project "Chainlets" (org "byramzan's Org",
eu-central-1, `https://zuvefozubbgstyljfxjh.supabase.co`) for REBOUND. No new project, no plan
change, no paid add-ons. Destructive cleanup requires a backup and explicit owner approval of the
exact list below. **Nothing in this list has been removed.** REBOUND lives in its own schema
`rebound` and does not read or depend on any object below.

## Observed state (inspected 26 Sep 2026, 14:00–14:25 UTC)

The project is **actively running PokeDrop** (`pokedrop.cards`), not idle:

| Resource | Detail | Live? |
|---|---|---|
| pg_cron job `pd-dispatch` (id 5) | every 5 s → `pd.dispatch()` → pg_net call to the `pd-worker` edge function | Yes — 718 successful runs in the last hour; latest job 14:04 UTC |
| Schema `pd` | 55 tables (jobs 17k rows, job_runs 17k, op_logs 1.9k, incident_records 1.6k, marketplace_candidates 1.3k, holder_index 378, ledger, awards, deliveries, sol_treasury…), triggers, functions | Yes |
| `pd.sol_treasury` | observed 830,624 lamports; gross envelope 3,914,600,264; settled downstream 3,872,826,730 | Yes — real SOL flows |
| Vault secrets (9) | `chainlets_mainnet_rpc_url`, `chainlets_indexer_key`, `chainlets_publishable_key`, `chainlets_indexer_key_v2`, `pd_worker_url`, `pd_worker_secret`, `pd_admin_secret`, `pd_solana_rpc_url`, **`pd_solana_signer_key`** | Yes |
| Edge functions (11) | `pd-worker`, `pd-admin`, `delivery-wallet`, `chainlets-metadata`, `chainlets-explorer`, `chainlets-control`, `chainlets-registry`, `chainlets-registry-indexer`, `chainlets-verification`, `chainlets-buyback`, `chainlets-token-stats` | Yes |
| Schema `archive_chainlets` | `snapshot` table | Archive |
| `public` tables | `public_awards`, `public_cards`, `public_config`, `public_deliveries`, `public_events` (in `supabase_realtime`), `public_rounds` | Yes (PokeDrop UI) |
| `public` functions | `get_cards`, `get_deliveries`, `get_me`, `get_public_events`, `get_public_snapshot`, `get_round`, `get_round_before_stream` | Yes |
| Storage bucket `chainlets-metadata` (public) | 23 objects | Possibly referenced by on-chain metadata — **must not be deleted** if any minted token points to it |
| Auth | 5 users, all Web3 (Solana) sign-ins with domain `pokedrop.cards` / `www.pokedrop.cards` | — |
| Supabase migrations | 26 PokeDrop/Chainlets migrations (20260918143330 … 20260925225618) | history |
| Extensions | pg_cron, pg_net, pgcrypto, uuid-ossp, supabase_vault, pg_stat_statements | shared |

Security advisor findings that belong to PokeDrop (not REBOUND): 56× "RLS enabled, no policy" in
`pd`/`archive_chainlets` (deny-all; informational), `public.get_round` executable by `anon`,
`public.get_me`/`get_round` executable by `authenticated`, leaked-password protection disabled.

## REBOUND isolation guarantees (already true)

- REBOUND admin rights are **not** inherited from any PokeDrop user: admin = explicitly listed
  wallet in `rebound.reward_admin_wallets` AND latest sign-in domain in
  `rebound.reward_allowed_auth_domains` (`rebound.wtf`, `www.rebound.wtf`). Verified on the live
  database: an existing PokeDrop user evaluates `reward_is_admin() = false` and sees 0 logs.
- No REBOUND object references `pd`, `archive_chainlets`, the `public.public_*` tables, their
  functions, Vault secrets or edge functions.

## Proposed cleanup (awaiting owner approval — do not execute without it)

Order matters; each step is reversible only from the backup.

1. **Owner action first:** withdraw any SOL remaining in the PokeDrop treasury / delivery wallet
   (the signer key is in Vault as `pd_solana_signer_key`) and stop public PokeDrop usage.
2. **Backup:** confirm a fresh Supabase daily backup exists (Pro plan) AND take a logical dump
   from a trusted machine:
   `pg_dump --schema=pd --schema=archive_chainlets --table='public.public_*' --no-owner -Fc -f chainlets-$(date +%F).dump "$OWNER_DB_URL"`;
   download the 23 `chainlets-metadata` objects; export the edge function sources
   (`supabase functions download <name>` for each of the 11).
3. Unschedule cron: `select cron.unschedule('pd-dispatch');`
4. Delete edge functions: the 11 listed above.
5. Drop `public` functions listed above and `public.public_*` tables (remove `public_events` from
   `supabase_realtime` first).
6. Drop schemas `pd` and `archive_chainlets` (CASCADE, after step 2 is verified).
7. Delete the 9 Vault secrets (after the owner confirms the signer wallet is empty/rotated).
8. Auth: keep or delete the 5 PokeDrop users (they have no REBOUND rights either way).
9. Storage `chainlets-metadata`: **keep** unless the owner confirms no minted token metadata points
   at it.
10. Extensions `pg_cron`/`pg_net`: keep (REBOUND may use Supabase Cron to enqueue bounded jobs).

Rollback: restore from the Supabase backup or `pg_restore -d "$OWNER_DB_URL" chainlets-<date>.dump`,
redeploy the downloaded functions, re-create the cron job and Vault secrets.
