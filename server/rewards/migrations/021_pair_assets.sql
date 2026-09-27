BEGIN;
-- Coins paired with another quote asset (owner decision 2026-09-28): a coin launched against an asset pump.fun
-- admits (a stablecoin, a tokenized stock, a wrapped coin…) collects its creator fees in that asset, so its
-- holders' losses are measured and paid in it (base units of the asset, in the same *_lamports columns). The
-- 15 % is swapped to SOL (Jupiter) and buys and burns the REBOUND token like every SOL coin.
ALTER TABLE reward_coins ADD COLUMN quote_token_program text, ADD COLUMN quote_decimals integer, ADD COLUMN quote_symbol text;
ALTER TABLE reward_public_tokens ADD COLUMN quote_decimals integer;
-- 15 % of a pair coin: its quote asset swapped to SOL before the buy-and-burn.
CREATE TABLE reward_swaps (
 id uuid PRIMARY KEY,
 mint text NOT NULL REFERENCES reward_coins(mint),
 quote_mint text NOT NULL,
 quote_amount reward_uint NOT NULL,
 expected_lamports reward_uint,
 min_lamports reward_uint,
 received_lamports reward_uint,
 signature text,
 state text NOT NULL DEFAULT 'swapping' CHECK(state IN ('swapping','swapped','failed')),
 reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reward_swaps_mint ON reward_swaps(mint,created_at);
SELECT reward_secure_new_tables();
GRANT SELECT,INSERT,UPDATE ON reward_swaps TO rebound_scheduler;
GRANT SELECT ON reward_swaps TO rebound_indexer,rebound_verifier,rebound_api;
INSERT INTO reward_schema_migrations(version) VALUES(21);
COMMIT;
