BEGIN;
-- Third-party creator-fee receipts (M4). One row per finalized collection transaction that moved
-- creator fees from the coin's Pump creator vaults into its per-mint intake PDA. Only these are
-- credited (split once on chain by Credit); setup rent and donations to the intake are recorded as
-- wallet movements, never as income.
ALTER TABLE reward_history_cursors DROP CONSTRAINT reward_history_cursors_role_check;
ALTER TABLE reward_history_cursors ADD CONSTRAINT reward_history_cursors_role_check CHECK(role IN ('mint','curve','pool','token_account','funding_wallet','intake'));
CREATE TABLE reward_intake_receipts (
 id text PRIMARY KEY,                                   -- hex receipt event (REBOUND:receipt:v3)
 mint text NOT NULL REFERENCES reward_coins(mint), signature text NOT NULL, instruction_path text NOT NULL,
 amount_lamports reward_uint NOT NULL CHECK(amount_lamports>0), sources jsonb NOT NULL,
 slot bigint NOT NULL, block_time bigint,
 state text NOT NULL DEFAULT 'observed' CHECK(state IN ('observed','credit_submitted','credited','held')),
 holder_lamports reward_uint, buyback_lamports reward_uint, receipt_account text, credit_signature text, reason text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(mint,signature,instruction_path),
 CHECK(state<>'credited' OR (holder_lamports+buyback_lamports=amount_lamports AND receipt_account IS NOT NULL))
);
CREATE FUNCTION reward_intake_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=rebound,public AS $$ BEGIN
 IF NEW.amount_lamports<>OLD.amount_lamports OR NEW.signature<>OLD.signature OR NEW.mint<>OLD.mint THEN RAISE EXCEPTION 'receipt evidence is immutable'; END IF;
 IF OLD.state='credited' THEN RAISE EXCEPTION 'credited receipt is final'; END IF;
 NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER intake_receipt_guard BEFORE UPDATE ON reward_intake_receipts FOR EACH ROW EXECUTE FUNCTION reward_intake_receipt_guard();
CREATE INDEX reward_intake_receipts_open ON reward_intake_receipts(mint,state) WHERE state<>'credited';
-- A burned buyback job is final except for appending closure evidence (unspent budget returned).
CREATE OR REPLACE FUNCTION reward_buyback_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=rebound,public AS $$ BEGIN
 IF NEW.target_mint<>OLD.target_mint OR NEW.budget_lamports<>OLD.budget_lamports OR NEW.source_mint<>OLD.source_mint OR NEW.config_version<>OLD.config_version THEN RAISE EXCEPTION 'buyback job target and budget are immutable'; END IF;
 IF OLD.purchase_signature IS NOT NULL AND NEW.purchase_signature IS DISTINCT FROM OLD.purchase_signature THEN RAISE EXCEPTION 'purchase evidence is immutable'; END IF;
 IF OLD.state IN ('purchased_pending_burn','burn_submitted') AND NEW.state NOT IN ('purchased_pending_burn','burn_submitted','burned','failed_action_required') THEN RAISE EXCEPTION 'a purchased job may only burn'; END IF;
 IF OLD.state='burned' AND (NEW.state<>'burned' OR NEW.burned_raw IS DISTINCT FROM OLD.burned_raw OR NEW.burn_signature IS DISTINCT FROM OLD.burn_signature OR NEW.acquired_raw IS DISTINCT FROM OLD.acquired_raw
  OR NEW.spent_lamports IS DISTINCT FROM OLD.spent_lamports OR NOT (NEW.evidence @> OLD.evidence)) THEN RAISE EXCEPTION 'burned job is final'; END IF;
 NEW.updated_at=now(); RETURN NEW; END $$;
SELECT reward_secure_new_tables();
GRANT SELECT,INSERT,UPDATE ON reward_intake_receipts TO rebound_indexer;
GRANT SELECT,UPDATE(state,holder_lamports,buyback_lamports,receipt_account,credit_signature,reason,updated_at) ON reward_intake_receipts TO rebound_scheduler;
GRANT SELECT ON reward_intake_receipts TO rebound_verifier,rebound_api;
INSERT INTO reward_schema_migrations(version) VALUES(9);
COMMIT;
