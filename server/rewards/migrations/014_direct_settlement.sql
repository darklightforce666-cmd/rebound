BEGIN;
-- Direct settlement (owner decision 2026-09-27): no REBOUND program on chain. The worker computes each
-- round exactly as before (finalized history, SOL losses, pro-rata, capped at the loss) and pays the
-- underwater holders with plain SOL transfers signed by the fee wallet's imported key.
--   * reward_platform.settlement: 'direct' (default) or 'program' (the V3 program, when deployed).
--   * A round computed while execution is dry_run is recorded as state 'dry_run': its awards stay
--     'planned', reserve nothing, and never count as compensation.
--   * reward_cycles.funding_wallet ties each round to the fee wallet whose budget it used.
ALTER TABLE reward_platform ADD COLUMN settlement text NOT NULL DEFAULT 'direct' CHECK(settlement IN ('direct','program'));
ALTER TABLE reward_cycles ADD COLUMN funding_wallet uuid REFERENCES reward_funding_wallets(id);
ALTER TABLE reward_cycles DROP CONSTRAINT IF EXISTS reward_cycles_state_check;
ALTER TABLE reward_cycles ADD CONSTRAINT reward_cycles_state_check CHECK(state IN ('scheduled','snapshotting','waiting_for_data','awaiting_funding_signature','funding_pending','funded','paying','partially_paid','complete','retrying','buyback_pending','burn_pending','paused','skipped_no_funds','skipped_no_eligible_holders','missed','expired','failed_action_required','dry_run'));
-- Lots are derived deterministically by replaying finalized events (ids "<signature>:<index>"); they are
-- not materialized in reward_lots, so award credits reference them by id without a foreign key.
ALTER TABLE reward_lot_credits DROP CONSTRAINT IF EXISTS reward_lot_credits_lot_id_fkey;
CREATE INDEX reward_cycles_funding_wallet ON reward_cycles(funding_wallet) WHERE funding_wallet IS NOT NULL;

-- ---------- public projections (anyone may read; Realtime pushes changes to every visitor) ----------
-- Round summary: what the snapshot found and what was paid.
ALTER TABLE reward_public_cycles
 ADD COLUMN mode text NOT NULL DEFAULT 'live' CHECK(mode IN ('live','dry_run')),
 ADD COLUMN holders_counted integer,
 ADD COLUMN holders_underwater integer,
 ADD COLUMN total_loss_lamports reward_uint,
 ADD COLUMN available_lamports reward_uint,
 ADD COLUMN paid_lamports reward_uint NOT NULL DEFAULT 0,
 ADD COLUMN paid_recipients integer NOT NULL DEFAULT 0;
-- Per-holder position at the latest snapshot (amounts in lamports; loss after compensation).
CREATE TABLE reward_public_holders (
 mint text NOT NULL, owner text NOT NULL,
 quantity_raw reward_uint NOT NULL DEFAULT 0,
 cost_lamports reward_uint NOT NULL DEFAULT 0,
 value_lamports reward_uint NOT NULL DEFAULT 0,
 compensated_lamports reward_uint NOT NULL DEFAULT 0,
 loss_lamports reward_uint NOT NULL DEFAULT 0,
 paid_lamports reward_uint NOT NULL DEFAULT 0,
 payouts integer NOT NULL DEFAULT 0,
 outcome text NOT NULL,
 cycle_number bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(mint,owner)
);
CREATE INDEX reward_public_holders_loss ON reward_public_holders(mint,loss_lamports DESC);
CREATE INDEX reward_public_holders_paid ON reward_public_holders(mint,paid_lamports DESC);
-- Every payment, with its transaction.
CREATE TABLE reward_public_payouts (
 id bigserial PRIMARY KEY,
 mint text NOT NULL, cycle_number bigint NOT NULL, owner text NOT NULL,
 amount_lamports reward_uint NOT NULL, loss_lamports reward_uint NOT NULL,
 signature text NOT NULL, paid_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(mint,cycle_number,owner)
);
CREATE INDEX reward_public_payouts_recent ON reward_public_payouts(mint,id DESC);
ALTER TABLE reward_public_tokens
 ADD COLUMN paid_recipients integer NOT NULL DEFAULT 0,
 ADD COLUMN payouts integer NOT NULL DEFAULT 0,
 ADD COLUMN holders_underwater integer,
 ADD COLUMN total_loss_lamports reward_uint,
 ADD COLUMN last_cycle bigint;
SELECT reward_secure_new_tables();

GRANT SELECT ON reward_public_holders, reward_public_payouts TO anon, authenticated;
CREATE POLICY public_holders_read ON reward_public_holders FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY public_payouts_read ON reward_public_payouts FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON reward_public_holders, reward_public_payouts TO rebound_api, rebound_indexer, rebound_verifier;
GRANT SELECT, INSERT, UPDATE ON reward_public_holders, reward_public_payouts TO rebound_scheduler;
GRANT USAGE, SELECT ON SEQUENCE reward_public_payouts_id_seq TO rebound_scheduler;
GRANT UPDATE(settlement) ON reward_platform TO rebound_api;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE rebound.reward_public_payouts;
 END IF;
END $$;
INSERT INTO reward_schema_migrations(version) VALUES(14);
COMMIT;
