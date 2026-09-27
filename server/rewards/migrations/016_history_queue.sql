BEGIN;
-- Smarter history ingestion (2026-09-27). Signature lists are cheap (1 request per 1000), transactions are
-- not (1 request each), so: list signatures only where relevant transactions can be — the mint, its
-- bonding curve, its canonical pool and the token accounts that CURRENTLY hold it — keep every listed
-- signature once in a durable queue (deduplicated across addresses), and fetch each transaction at most
-- once, in batches. Wallets that sold everything are never crawled.
CREATE TABLE reward_history_queue (
 mint text NOT NULL REFERENCES reward_coins(mint),
 signature text NOT NULL,
 slot bigint NOT NULL,
 block_index integer,
 fetched_at timestamptz,
 events integer,
 PRIMARY KEY(mint,signature)
);
CREATE INDEX reward_history_queue_pending ON reward_history_queue(mint,slot) WHERE fetched_at IS NULL;
ALTER TABLE reward_public_tokens ADD COLUMN history_fetched integer, ADD COLUMN history_total integer, ADD COLUMN history_complete boolean;
SELECT reward_secure_new_tables();
GRANT SELECT,INSERT,UPDATE ON reward_history_queue TO rebound_indexer;
GRANT SELECT ON reward_history_queue TO rebound_scheduler,rebound_verifier,rebound_api;
INSERT INTO reward_schema_migrations(version) VALUES(16);
COMMIT;
