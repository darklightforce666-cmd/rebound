-- Run once as the database schema owner after migrations. No passwords here.
-- Grant each NOLOGIN role to a distinct managed-database login in your provider.
-- Do not grant schema-owner credentials or all roles to a worker.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rebound_api') THEN CREATE ROLE rebound_api NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rebound_indexer') THEN CREATE ROLE rebound_indexer NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rebound_scheduler') THEN CREATE ROLE rebound_scheduler NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rebound_verifier') THEN CREATE ROLE rebound_verifier NOLOGIN; END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rebound_api,rebound_indexer,rebound_scheduler,rebound_verifier;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rebound_indexer,rebound_scheduler,rebound_verifier;
GRANT SELECT ON reward_coins,reward_accounts,reward_deployments,reward_rounds,reward_allocations,reward_position_views,reward_disqualifications,reward_events,reward_checkpoints,reward_launch_attempts,reward_challenges,reward_rate_limits TO rebound_api;
GRANT INSERT,UPDATE ON reward_launch_attempts,reward_challenges,reward_rate_limits TO rebound_api;
GRANT INSERT ON reward_coins,reward_accounts TO rebound_api;
GRANT UPDATE(status,launch_slot,activation_slot,activation_evidence,current_creator,blocked_reason) ON reward_coins TO rebound_api;
GRANT INSERT ON reward_raw_blocks,reward_events,reward_disqualifications,reward_audit TO rebound_indexer;
GRANT INSERT,UPDATE ON reward_token_ownership,reward_checkpoints TO rebound_indexer;
GRANT UPDATE(continuously_held) ON reward_purchase_lots TO rebound_indexer;
GRANT UPDATE(blocked_reason) ON reward_coins TO rebound_indexer;
GRANT INSERT,UPDATE ON reward_accounts,reward_positions,reward_rounds,reward_allocations,reward_chain_attempts,reward_jobs,reward_receipts,reward_fee_accruals,reward_authorizations TO rebound_scheduler;
GRANT INSERT ON reward_journal,reward_receipt_sources,reward_audit TO rebound_scheduler;
GRANT INSERT ON reward_asset_observations TO rebound_scheduler;
GRANT INSERT,UPDATE ON reward_positions,reward_position_views,reward_purchase_lots,reward_wallet_links,reward_authorizations,reward_nonce_uses,reward_chain_attempts,reward_allocations TO rebound_verifier;
GRANT INSERT ON reward_audit TO rebound_verifier;
GRANT UPDATE(blocked_reason) ON reward_coins TO rebound_verifier;
-- The scheduler computes a proposal independently; it needs projection writes,
-- but cannot change the service registry, confirmed exits or raw evidence.
GRANT INSERT,UPDATE ON reward_position_views,reward_purchase_lots,reward_wallet_links TO rebound_scheduler;
GRANT UPDATE(blocked_reason) ON reward_coins TO rebound_scheduler;
GRANT USAGE,SELECT ON SEQUENCE reward_audit_id_seq TO rebound_indexer,rebound_scheduler,rebound_verifier;
