BEGIN;
-- Ready-made holder positions (2026-09-27). Rounds no longer replay a token's whole history: a projector
-- applies every verified event once, in chain order, to the positions it touches, and a round's snapshot
-- only revalues those positions at the cutoff price.
--   reward_holder_positions  one row per (mint, owner): remaining FIFO lots (quantity, remaining SOL cost,
--                            compensation credits), wallet-level holds, and totals for queries
--   reward_holder_accounts   token account → owner and balance (proves reconstructed holdings)
--   reward_projection_state  per mint: the slot through which events are applied, how many events and
--                            award credits that covers (a mismatch means a late event or a changed award
--                            → the positions are rebuilt from the stored events), mint-level holds
-- The projector runs as the scheduler role (the only writer), under the coin's lease, so positions and
-- award reservations never race.
CREATE TABLE reward_holder_positions (
 mint text NOT NULL REFERENCES reward_coins(mint),
 owner text NOT NULL,
 lots jsonb NOT NULL DEFAULT '[]'::jsonb,
 holds jsonb NOT NULL DEFAULT '[]'::jsonb,
 recognized_raw reward_uint NOT NULL DEFAULT 0,
 unrecognized_raw reward_uint NOT NULL DEFAULT 0,
 cost_lamports reward_uint NOT NULL DEFAULT 0,
 credit_lamports reward_uint NOT NULL DEFAULT 0,
 basis_pending boolean NOT NULL DEFAULT false,
 updated_slot bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(mint,owner)
);
CREATE TABLE reward_holder_accounts (
 mint text NOT NULL REFERENCES reward_coins(mint),
 account text NOT NULL,
 owner text,
 amount reward_uint NOT NULL DEFAULT 0,
 updated_slot bigint NOT NULL,
 PRIMARY KEY(mint,account)
);
CREATE INDEX reward_holder_accounts_owner ON reward_holder_accounts(mint,owner);
CREATE TABLE reward_projection_state (
 mint text PRIMARY KEY REFERENCES reward_coins(mint),
 applied_slot bigint NOT NULL DEFAULT -1,
 applied_time bigint,
 events_applied bigint NOT NULL DEFAULT 0,
 credits_applied bigint NOT NULL DEFAULT 0,
 lot_seq bigint NOT NULL DEFAULT 0,
 mint_holds jsonb NOT NULL DEFAULT '[]'::jsonb,
 parser_version text,
 rebuilds integer NOT NULL DEFAULT 0,
 last_rebuild_reason text,
 last_rebuild_at timestamptz,
 price_s18 numeric,
 price_time bigint,
 revalued_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- Freshness shown on the site: what the chain head is, how far history is verified, how far positions are
-- applied, and when the indexer last ran.
ALTER TABLE reward_public_tokens
 ADD COLUMN head_slot bigint, ADD COLUMN head_time bigint,
 ADD COLUMN verified_slot bigint, ADD COLUMN verified_time bigint,
 ADD COLUMN positions_slot bigint, ADD COLUMN positions_time bigint,
 ADD COLUMN indexer_at timestamptz, ADD COLUMN price_s18 numeric;
ALTER TABLE reward_public_cycles ADD COLUMN reason text;
SELECT reward_secure_new_tables();

GRANT SELECT,INSERT,UPDATE,DELETE ON reward_holder_positions,reward_holder_accounts,reward_projection_state TO rebound_scheduler;
GRANT SELECT ON reward_holder_positions,reward_holder_accounts,reward_projection_state TO rebound_indexer,rebound_verifier,rebound_api;
GRANT DELETE ON reward_public_holders TO rebound_scheduler;
INSERT INTO reward_schema_migrations(version) VALUES(17);
COMMIT;
