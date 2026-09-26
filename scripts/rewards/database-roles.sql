-- Run as the schema owner AFTER migrations (idempotent). No passwords in this file.
-- Creates NOLOGIN privilege groups. Give each runtime component its own LOGIN role in the
-- provider (see docs/SUPABASE-SETUP.md), e.g.:
--   CREATE ROLE rebound_api_login LOGIN PASSWORD '<from secret manager>' IN ROLE rebound_api;
--   ALTER ROLE rebound_api_login SET search_path = rebound, public;
-- Never give a worker the schema-owner, postgres or service-role credentials.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rebound_api') THEN CREATE ROLE rebound_api NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rebound_indexer') THEN CREATE ROLE rebound_indexer NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rebound_scheduler') THEN CREATE ROLE rebound_scheduler NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rebound_verifier') THEN CREATE ROLE rebound_verifier NOLOGIN; END IF;
END $$;
SET search_path TO rebound, public;
GRANT USAGE ON SCHEMA rebound TO rebound_api,rebound_indexer,rebound_scheduler,rebound_verifier;
REVOKE ALL ON ALL TABLES IN SCHEMA rebound FROM rebound_api,rebound_indexer,rebound_scheduler,rebound_verifier;

-- ---------- reads ----------
-- Workers and verifier read everything except signer key material (column grant below).
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='rebound' AND tablename<>'reward_signers' LOOP
  EXECUTE format('GRANT SELECT ON rebound.%I TO rebound_indexer,rebound_scheduler,rebound_verifier',t.tablename);
 END LOOP;
END $$;
GRANT SELECT(id,address,role,storage,external_reference,status,created_at,revoked_at,rotated_from,last_health_at,last_health_ok) ON reward_signers TO rebound_api,rebound_indexer,rebound_verifier;
-- Only the settlement scheduler may read ciphertext; decryption also needs the master key,
-- which exists only in the scheduler's runtime environment, never in the database.
GRANT SELECT ON reward_signers TO rebound_scheduler;

GRANT SELECT ON reward_policies,reward_platform,reward_config_versions,reward_coins,reward_deployments,reward_cycles,reward_awards,
 reward_snapshot_positions,reward_buyback_jobs,reward_launch_attempts,reward_challenges,reward_rate_limits,reward_assets,reward_logs,reward_health,
 reward_admin_wallets,reward_allowed_auth_domains,reward_public_tokens,reward_public_cycles,reward_funding_wallets,reward_funding_accounts,
 reward_funding_credits,reward_jobs,reward_intents,reward_chain_attempts,reward_checkpoints,reward_lots,reward_leases TO rebound_api;

-- ---------- API (short requests; admin actions are audited in reward_config_versions) ----------
GRANT INSERT,UPDATE ON reward_challenges,reward_rate_limits,reward_launch_attempts,reward_leases TO rebound_api;
GRANT INSERT ON reward_assets,reward_logs,reward_config_versions,reward_jobs,reward_intents TO rebound_api;
GRANT UPDATE(execution_mode,primary_mint,config_version,test_allowlist_mints,test_allowlist_wallets,spend_cap_action_lamports,spend_cap_cycle_lamports,spend_cap_total_lamports,buyback_max_slippage_bps,buyback_max_impact_bps,paused,pause_reason,spent_total_lamports,updated_at) ON reward_platform TO rebound_api;
GRANT INSERT ON reward_coins TO rebound_api;
GRANT UPDATE(status,blocked_reason,name,symbol,image_uri,metadata_uri,pinned,updated_at,launch_signature,launch_time,launch_slot,activation_signature,activation_time,activation_slot,activation_evidence,schedule_anchor,cycle_seconds,cutoff_lead_seconds) ON reward_coins TO rebound_api;
GRANT INSERT ON reward_funding_wallets TO rebound_api;
GRANT UPDATE(mode,signer,operational_reserve_lamports,opening_balance_lamports,opening_credit_lamports,opening_slot,status,retired_at) ON reward_funding_wallets TO rebound_api;
GRANT INSERT,UPDATE(revoked_at,revoked_by) ON reward_admin_wallets TO rebound_api;
GRANT UPDATE(state,body,body_hash,updated_at) ON reward_intents TO rebound_api;   -- manual plans: refresh blockhash, mark submitted
GRANT INSERT,UPDATE ON reward_chain_attempts TO rebound_api;   -- persist user-signed bytes before broadcast
GRANT UPDATE(state,due_at,next_retry_at,updated_at) ON reward_jobs TO rebound_api;

-- ---------- indexer (finalized evidence, lots, prices, public market projection) ----------
GRANT INSERT ON reward_raw_blocks,reward_events,reward_lots,reward_lot_movements,reward_sol_usd,reward_price_observations,reward_wallet_movements,reward_audit,reward_logs TO rebound_indexer;
GRANT UPDATE(remaining_quantity_raw,remaining_cost_usd,paid_compensation_usd,reserved_compensation_usd) ON reward_lots TO rebound_indexer;
GRANT INSERT,UPDATE ON reward_token_ownership,reward_checkpoints,reward_health,reward_public_tokens,reward_leases TO rebound_indexer;
GRANT UPDATE(blocked_reason,history_start_slot,history_complete_slot,venue_coverage,decimals,token_program,status,updated_at) ON reward_coins TO rebound_indexer;
GRANT UPDATE(state,lease_owner,lease_until,attempts,checkpoint,error,next_retry_at,last_error_code,updated_at) ON reward_jobs TO rebound_indexer;

-- ---------- scheduler / settlement ----------
GRANT INSERT,UPDATE ON reward_cycles,reward_awards,reward_funding_accounts,reward_buyback_jobs,reward_intents,reward_chain_attempts,
 reward_jobs,reward_leases,reward_health,reward_public_cycles,reward_public_tokens,reward_funding_wallets TO rebound_scheduler;
GRANT INSERT ON reward_snapshot_positions,reward_lot_credits,reward_funding_credits,reward_ledger,reward_wallet_movements,reward_logs,reward_audit,reward_assets TO rebound_scheduler;
GRANT UPDATE(paid_compensation_usd,reserved_compensation_usd) ON reward_lots TO rebound_scheduler;
GRANT UPDATE(status,blocked_reason,updated_at) ON reward_coins TO rebound_scheduler;
GRANT UPDATE(last_health_at,last_health_ok) ON reward_signers TO rebound_scheduler;
GRANT UPDATE(paused,pause_reason,spent_total_lamports,updated_at) ON reward_platform TO rebound_scheduler;

-- ---------- verifier (independent read + attestations only) ----------
GRANT INSERT ON reward_logs,reward_audit TO rebound_verifier;
GRANT INSERT,UPDATE ON reward_nonce_uses,reward_leases,reward_health TO rebound_verifier;

-- Sequences for append-only tables.
GRANT USAGE,SELECT ON SEQUENCE reward_audit_id_seq,reward_logs_id_seq TO rebound_api,rebound_indexer,rebound_scheduler,rebound_verifier;
GRANT USAGE,SELECT ON SEQUENCE reward_config_versions_id_seq TO rebound_api;
-- Helper functions used by server code.
GRANT EXECUTE ON FUNCTION reward_user_wallets(uuid) TO rebound_api;
