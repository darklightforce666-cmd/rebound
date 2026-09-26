BEGIN;
-- Incremental mint-scoped history (history-v3 / worker-v3): newest finalized signature ingested per
-- tracked address (mint, bonding curve, canonical pool and every token account of the mint).
CREATE TABLE reward_history_cursors (
 mint text NOT NULL REFERENCES reward_coins(mint), address text NOT NULL, role text NOT NULL CHECK(role IN ('mint','curve','pool','token_account','funding_wallet')),
 newest_signature text, newest_slot bigint, discovered_slot bigint, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(mint,address)
);
SELECT reward_secure_new_tables();
GRANT SELECT,INSERT,UPDATE ON reward_history_cursors TO rebound_indexer;
GRANT SELECT ON reward_history_cursors TO rebound_scheduler,rebound_verifier,rebound_api;
INSERT INTO reward_schema_migrations(version) VALUES(8);
COMMIT;
