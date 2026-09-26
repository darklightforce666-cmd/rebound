BEGIN;
-- REBOUND V3 data model (spec §15). Additive only: migrations 001-004 are never edited.
-- V2-only tables (reward_purchase_lots, reward_disqualifications, reward_wallet_links,
-- reward_link_corrections, reward_positions, reward_accounts, reward_rounds,
-- reward_allocations, reward_authorizations, reward_payment_attempts) are frozen as
-- historical evidence of the unused V2 policy. V3 code never writes them.

CREATE DOMAIN reward_usd AS numeric(40,0) CHECK(VALUE>=0);  -- usd_pico: 1 USD = 10^12

-- ---------- policies and prospective configuration ----------
CREATE TABLE reward_policies (
 version text PRIMARY KEY, hash text NOT NULL UNIQUE, canonical text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('production','test')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_policies BEFORE UPDATE OR DELETE ON reward_policies FOR EACH ROW EXECUTE FUNCTION reward_immutable();

CREATE TABLE reward_platform (
 namespace text PRIMARY KEY CHECK(namespace IN ('production','mainnet_test')),
 execution_mode text NOT NULL DEFAULT 'dry_run' CHECK(execution_mode IN ('dry_run','mainnet_test','production')),
 policy_version text NOT NULL REFERENCES reward_policies(version),
 primary_mint text, config_version bigint NOT NULL DEFAULT 0,
 test_allowlist_mints text[] NOT NULL DEFAULT '{}', test_allowlist_wallets text[] NOT NULL DEFAULT '{}',
 spend_cap_action_lamports reward_uint NOT NULL DEFAULT 0, spend_cap_cycle_lamports reward_uint NOT NULL DEFAULT 0,
 spend_cap_total_lamports reward_uint NOT NULL DEFAULT 0, spent_total_lamports reward_uint NOT NULL DEFAULT 0,
 buyback_max_slippage_bps integer NOT NULL DEFAULT 100 CHECK(buyback_max_slippage_bps BETWEEN 1 AND 300),
 buyback_max_impact_bps integer NOT NULL DEFAULT 200 CHECK(buyback_max_impact_bps BETWEEN 1 AND 1000),
 paused boolean NOT NULL DEFAULT false, pause_reason text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(namespace<>'production' OR execution_mode<>'mainnet_test'),
 CHECK(namespace<>'mainnet_test' OR execution_mode<>'production'),
 CHECK(spent_total_lamports<=spend_cap_total_lamports OR execution_mode<>'mainnet_test')
);

CREATE TABLE reward_config_versions (
 id bigserial PRIMARY KEY, namespace text NOT NULL REFERENCES reward_platform(namespace),
 version bigint NOT NULL, change text NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
 actor_user uuid, actor_wallet text, request_id text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(namespace,version)
);
CREATE TRIGGER immutable_config_versions BEFORE UPDATE OR DELETE ON reward_config_versions FOR EACH ROW EXECUTE FUNCTION reward_immutable();

-- ---------- deployments and coins (extended in place) ----------
ALTER TABLE reward_deployments
 ADD COLUMN program_version text NOT NULL DEFAULT 'v2',
 ADD COLUMN namespace text NOT NULL DEFAULT 'production' CHECK(namespace IN ('production','mainnet_test')),
 ADD COLUMN test_mode boolean NOT NULL DEFAULT false,
 ADD COLUMN fee_payer text, ADD COLUMN binary_sha256 text;
ALTER TABLE reward_deployments ALTER COLUMN operations DROP NOT NULL;
ALTER TABLE reward_deployments ADD CONSTRAINT reward_deployments_v3_no_operations CHECK(program_version='v2' OR operations IS NULL);
ALTER TABLE reward_deployments ADD CONSTRAINT reward_deployments_test_namespace CHECK(test_mode=(namespace='mainnet_test'));

ALTER TABLE reward_coins ALTER COLUMN deployment DROP NOT NULL;
ALTER TABLE reward_coins ALTER COLUMN launcher DROP NOT NULL;
ALTER TABLE reward_coins ALTER COLUMN intake DROP NOT NULL;
ALTER TABLE reward_coins ALTER COLUMN treasury DROP NOT NULL;
ALTER TABLE reward_coins ALTER COLUMN sharing_config DROP NOT NULL;
ALTER TABLE reward_coins DROP CONSTRAINT reward_coins_status_check;
ALTER TABLE reward_coins ADD CONSTRAINT reward_coins_status_check CHECK(status IN (
 'preparing','verifying','active','blocked','paused',                      -- V2 values kept for history
 'registered','indexing','ready','created_pending_activation','activating','retired'));
ALTER TABLE reward_coins
 ADD COLUMN kind text NOT NULL DEFAULT 'third_party' CHECK(kind IN ('primary','third_party')),
 ADD COLUMN namespace text NOT NULL DEFAULT 'production' CHECK(namespace IN ('production','mainnet_test')),
 ADD COLUMN program_version text NOT NULL DEFAULT 'v2',
 ADD COLUMN policy_version text REFERENCES reward_policies(version),
 ADD COLUMN token_program text, ADD COLUMN decimals integer CHECK(decimals BETWEEN 0 AND 18),
 ADD COLUMN name text, ADD COLUMN symbol text, ADD COLUMN image_uri text, ADD COLUMN metadata_uri text,
 ADD COLUMN creator_wallet text, ADD COLUMN creator_user uuid,
 ADD COLUMN launch_signature text, ADD COLUMN launch_time bigint,
 ADD COLUMN activation_signature text, ADD COLUMN activation_time bigint,
 ADD COLUMN schedule_anchor bigint, ADD COLUMN cycle_seconds integer, ADD COLUMN cutoff_lead_seconds integer,
 ADD COLUMN primary_target_mint text, ADD COLUMN history_start_slot bigint, ADD COLUMN history_complete_slot bigint,
 ADD COLUMN venue_coverage jsonb NOT NULL DEFAULT '{}',
 ADD COLUMN pinned boolean NOT NULL DEFAULT false,
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
 ADD CONSTRAINT reward_coins_schedule CHECK(schedule_anchor IS NULL OR (cycle_seconds>0 AND cutoff_lead_seconds>0 AND cutoff_lead_seconds<cycle_seconds)),
 ADD CONSTRAINT reward_coins_third_party_target CHECK(kind<>'third_party' OR program_version='v2' OR status<>'active' OR primary_target_mint IS NOT NULL),
 ADD CONSTRAINT reward_coins_not_own_target CHECK(primary_target_mint IS NULL OR primary_target_mint<>mint);
-- Exactly one active primary mint per namespace.
CREATE UNIQUE INDEX reward_one_primary ON reward_coins(namespace) WHERE kind='primary' AND status NOT IN ('retired');
CREATE INDEX reward_coins_listing ON reward_coins(namespace,status,launch_time DESC);

-- ---------- funding wallets and signer references ----------
CREATE TABLE reward_signers (
 id uuid PRIMARY KEY, address text NOT NULL, role text NOT NULL CHECK(role IN ('primary_dev','fee_payer','publisher','verifier')),
 storage text NOT NULL CHECK(storage IN ('encrypted_local','key_file','managed')),
 -- Ciphertext only (AES-256-GCM). The master key lives outside the database.
 ciphertext bytea, iv bytea, auth_tag bytea, key_version integer,
 external_reference text, status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','revoked','rotating')),
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, rotated_from uuid REFERENCES reward_signers(id),
 last_health_at timestamptz, last_health_ok boolean,
 CHECK((storage='encrypted_local')=(ciphertext IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL))
);
CREATE UNIQUE INDEX reward_signer_live ON reward_signers(role,address) WHERE status<>'revoked';

CREATE TABLE reward_funding_wallets (
 id uuid PRIMARY KEY, namespace text NOT NULL CHECK(namespace IN ('production','mainnet_test')),
 mint text NOT NULL REFERENCES reward_coins(mint), address text NOT NULL,
 mode text NOT NULL DEFAULT 'manual' CHECK(mode IN ('manual','automatic')),
 signer uuid REFERENCES reward_signers(id), ownership_proof jsonb NOT NULL,
 operational_reserve_lamports reward_uint NOT NULL DEFAULT 0,
 opening_balance_lamports reward_uint, opening_credit_lamports reward_uint, opening_slot bigint,
 reconciled_through_slot bigint, reconciled_signature text,
 status text NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','active','paused','retired')),
 created_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz,
 CHECK(mode='manual' OR signer IS NOT NULL)
);
-- A wallet can back only one live primary funding account.
CREATE UNIQUE INDEX reward_funding_wallet_live ON reward_funding_wallets(address) WHERE status<>'retired';
CREATE UNIQUE INDEX reward_funding_wallet_mint ON reward_funding_wallets(mint) WHERE status<>'retired';

-- ---------- lots (V3) ----------
CREATE TABLE reward_lots (
 id text PRIMARY KEY, mint text NOT NULL REFERENCES reward_coins(mint), owner text NOT NULL,
 source_event_id text NOT NULL REFERENCES reward_events(id),
 kind text NOT NULL CHECK(kind IN ('purchase','unrecognized_incoming')),
 quantity_raw reward_uint NOT NULL CHECK(quantity_raw>0), remaining_quantity_raw reward_uint NOT NULL,
 cost_lamports reward_uint NOT NULL DEFAULT 0, cost_usd reward_usd NOT NULL DEFAULT 0, remaining_cost_usd reward_usd NOT NULL DEFAULT 0,
 paid_compensation_usd reward_usd NOT NULL DEFAULT 0, reserved_compensation_usd reward_usd NOT NULL DEFAULT 0,
 fx_evidence jsonb, acquired_at bigint NOT NULL, acquired_slot bigint NOT NULL, fifo_order bigint NOT NULL,
 parser_version text NOT NULL, policy_version text NOT NULL REFERENCES reward_policies(version),
 CHECK(remaining_quantity_raw<=quantity_raw), CHECK(remaining_cost_usd<=cost_usd),
 CHECK(kind='purchase' OR (cost_usd=0 AND cost_lamports=0))
);
CREATE INDEX reward_lots_owner ON reward_lots(mint,owner,fifo_order) WHERE remaining_quantity_raw>0;

CREATE TABLE reward_lot_movements (
 lot_id text NOT NULL REFERENCES reward_lots(id), event_id text NOT NULL REFERENCES reward_events(id),
 kind text NOT NULL CHECK(kind IN ('disposal','burn','owner_change')),
 quantity_raw reward_uint NOT NULL, cost_usd_removed reward_usd NOT NULL,
 paid_credit_removed reward_usd NOT NULL, reserved_credit_removed reward_usd NOT NULL,
 slot bigint NOT NULL, PRIMARY KEY(lot_id,event_id)
);
CREATE TRIGGER immutable_lot_movements BEFORE UPDATE OR DELETE ON reward_lot_movements FOR EACH ROW EXECUTE FUNCTION reward_immutable();

-- ---------- prices ----------
CREATE TABLE reward_sol_usd (
 feed_id text NOT NULL, publish_time bigint NOT NULL, price_usd_pico reward_usd NOT NULL CHECK(price_usd_pico>0),
 conf_usd_pico reward_usd NOT NULL, source text NOT NULL, evidence jsonb NOT NULL,
 PRIMARY KEY(feed_id,publish_time)
);
CREATE TRIGGER immutable_sol_usd BEFORE UPDATE OR DELETE ON reward_sol_usd FOR EACH ROW EXECUTE FUNCTION reward_immutable();
ALTER TABLE reward_price_observations
 ADD COLUMN quote_model text CHECK(quote_model IN ('curve','amm')), ADD COLUMN block_time bigint,
 ADD COLUMN heartbeat boolean NOT NULL DEFAULT false, ADD COLUMN invalidated boolean NOT NULL DEFAULT false,
 ADD COLUMN supply_raw reward_uint;

-- ---------- funding (split once at the boundary) ----------
CREATE TABLE reward_funding_accounts (
 mint text PRIMARY KEY REFERENCES reward_coins(mint), kind text NOT NULL CHECK(kind IN ('primary','third_party')),
 credited reward_uint NOT NULL DEFAULT 0,
 holder_awaiting_transfer reward_uint NOT NULL DEFAULT 0,   -- primary only: holder 85% still on the dev wallet
 holder_available reward_uint NOT NULL DEFAULT 0, holder_reserved reward_uint NOT NULL DEFAULT 0, holder_paid reward_uint NOT NULL DEFAULT 0,
 other_available reward_uint NOT NULL DEFAULT 0, other_reserved reward_uint NOT NULL DEFAULT 0, other_settled reward_uint NOT NULL DEFAULT 0,
 split_carry integer NOT NULL DEFAULT 0 CHECK(split_carry BETWEEN 0 AND 99),
 operational_reserve reward_uint NOT NULL DEFAULT 0, unexplained_lamports reward_uint NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 0, chain_slot bigint, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(credited=holder_awaiting_transfer+holder_available+holder_reserved+holder_paid+other_available+other_reserved+other_settled),
 CHECK(kind='primary' OR holder_awaiting_transfer=0),
 CHECK(kind='third_party' OR (other_available=0 AND other_reserved=0))
);
CREATE TABLE reward_funding_credits (
 id text PRIMARY KEY, mint text NOT NULL REFERENCES reward_coins(mint),
 source text NOT NULL CHECK(source IN ('primary_wallet','primary_opening','creator_fee')),
 gross_lamports reward_uint NOT NULL CHECK(gross_lamports>0), holder_lamports reward_uint NOT NULL, other_lamports reward_uint NOT NULL,
 carry_before integer NOT NULL, carry_after integer NOT NULL,
 signature text, instruction_path text, slot bigint, block_time bigint, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(holder_lamports+other_lamports=gross_lamports), UNIQUE(mint,signature,instruction_path)
);
CREATE TRIGGER immutable_funding_credits BEFORE UPDATE OR DELETE ON reward_funding_credits FOR EACH ROW EXECUTE FUNCTION reward_immutable();
CREATE TABLE reward_ledger (
 id text PRIMARY KEY, mint text NOT NULL REFERENCES reward_coins(mint), kind text NOT NULL, reference text NOT NULL,
 deltas jsonb NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
 chain_signature text, chain_slot bigint, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(mint,kind,reference)
);
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON reward_ledger FOR EACH ROW EXECUTE FUNCTION reward_immutable();
-- Non-funding lamports observed at program treasuries / dev wallets (rent, WSOL refunds, donations, spends).
CREATE TABLE reward_wallet_movements (
 id text PRIMARY KEY, mint text NOT NULL REFERENCES reward_coins(mint), address text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('in','out')), lamports reward_uint NOT NULL,
 classification text NOT NULL CHECK(classification IN ('funding','rent','wsol_refund','donation','holder_transfer','owner_withdrawal','network_fee','reward_payment','buyback','unexpected')),
 signature text NOT NULL, slot bigint NOT NULL, block_time bigint, evidence jsonb NOT NULL
);
CREATE TRIGGER immutable_wallet_movements BEFORE UPDATE OR DELETE ON reward_wallet_movements FOR EACH ROW EXECUTE FUNCTION reward_immutable();

-- ---------- cycles, snapshots, awards ----------
CREATE TABLE reward_cycles (
 id text PRIMARY KEY, deployment text REFERENCES reward_deployments(id), mint text NOT NULL REFERENCES reward_coins(mint),
 cycle_number bigint NOT NULL CHECK(cycle_number>=1), namespace text NOT NULL, policy_version text NOT NULL REFERENCES reward_policies(version),
 config_version bigint NOT NULL, anchor bigint NOT NULL, cycle_start bigint NOT NULL, scheduled_end bigint NOT NULL, cutoff_time bigint NOT NULL,
 cutoff_slot bigint, cutoff_block_time bigint,
 state text NOT NULL CHECK(state IN ('scheduled','snapshotting','waiting_for_data','awaiting_funding_signature','funding_pending','funded','paying','partially_paid','complete','retrying','buyback_pending','burn_pending','paused','skipped_no_funds','skipped_no_eligible_holders','missed','expired','failed_action_required')),
 funding_mode text CHECK(funding_mode IN ('manual','automatic','program_treasury')),
 sol_usd_pico reward_usd, reference_price_q18 numeric(78,0), holder_reserve_lamports reward_uint, budget_lamports reward_uint,
 total_lamports reward_uint, total_loss_usd reward_usd, eligible_count integer, snapshot_hash text, manifest_hash text, manifest_path text, root text,
 plan_expires_at bigint, funding_intent uuid, funding_signature text, due_at bigint NOT NULL,
 submitted_at timestamptz, finalized_at timestamptz, reason text, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cutoff_time<scheduled_end AND cycle_start<cutoff_time AND due_at=scheduled_end)
);
CREATE UNIQUE INDEX reward_cycle_unique ON reward_cycles(COALESCE(deployment,''),mint,cycle_number);
CREATE INDEX reward_cycles_state ON reward_cycles(state,due_at);
-- Only one unresolved unfunded primary plan per mint (spec §9).
CREATE UNIQUE INDEX reward_one_unfunded_plan ON reward_cycles(mint) WHERE state IN ('awaiting_funding_signature','funding_pending');
CREATE FUNCTION reward_cycle_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.snapshot_hash IS NOT NULL AND (NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash OR NEW.cutoff_slot IS DISTINCT FROM OLD.cutoff_slot OR NEW.sol_usd_pico IS DISTINCT FROM OLD.sol_usd_pico OR NEW.reference_price_q18 IS DISTINCT FROM OLD.reference_price_q18) THEN RAISE EXCEPTION 'immutable cycle snapshot'; END IF;
 IF OLD.manifest_hash IS NOT NULL AND (NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash OR NEW.root IS DISTINCT FROM OLD.root OR NEW.total_lamports IS DISTINCT FROM OLD.total_lamports) THEN RAISE EXCEPTION 'immutable funded manifest'; END IF;
 IF NEW.cutoff_time<>OLD.cutoff_time OR NEW.scheduled_end<>OLD.scheduled_end OR NEW.anchor<>OLD.anchor OR NEW.policy_version<>OLD.policy_version THEN RAISE EXCEPTION 'immutable cycle schedule'; END IF;
 NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER immutable_cycle BEFORE UPDATE ON reward_cycles FOR EACH ROW EXECUTE FUNCTION reward_cycle_immutable();
CREATE TRIGGER no_cycle_delete BEFORE DELETE ON reward_cycles FOR EACH ROW EXECUTE FUNCTION reward_immutable();

CREATE TABLE reward_snapshot_positions (
 cycle_id text NOT NULL REFERENCES reward_cycles(id), owner text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('eligible','no_remaining_loss','hold','excluded','no_recognized_quantity')),
 reason text, quantity_raw reward_uint NOT NULL DEFAULT 0, cost_usd reward_usd NOT NULL DEFAULT 0, value_usd reward_usd NOT NULL DEFAULT 0,
 credit_usd reward_usd NOT NULL DEFAULT 0, loss_usd reward_usd NOT NULL DEFAULT 0, unrecognized_raw reward_uint NOT NULL DEFAULT 0,
 lots jsonb NOT NULL DEFAULT '[]', PRIMARY KEY(cycle_id,owner)
);
CREATE TRIGGER immutable_snapshot_positions BEFORE UPDATE OR DELETE ON reward_snapshot_positions FOR EACH ROW EXECUTE FUNCTION reward_immutable();

CREATE TABLE reward_awards (
 cycle_id text NOT NULL REFERENCES reward_cycles(id), leaf_index integer NOT NULL, mint text NOT NULL REFERENCES reward_coins(mint),
 recipient text NOT NULL, amount_lamports reward_uint NOT NULL CHECK(amount_lamports>0), credit_usd reward_usd NOT NULL,
 lot_credits jsonb NOT NULL, proof jsonb,
 state text NOT NULL CHECK(state IN ('planned','reserved','paid','deferred_rent','released')),
 receipt_address text, settlement_signature text, settled_slot bigint, state_version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(cycle_id,leaf_index), UNIQUE(cycle_id,recipient)
);
CREATE INDEX reward_awards_recipient ON reward_awards(mint,recipient);
CREATE FUNCTION reward_award_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.amount_lamports<>OLD.amount_lamports OR NEW.recipient<>OLD.recipient OR NEW.credit_usd<>OLD.credit_usd OR NEW.lot_credits IS DISTINCT FROM OLD.lot_credits OR (OLD.proof IS NOT NULL AND NEW.proof IS DISTINCT FROM OLD.proof) THEN RAISE EXCEPTION 'immutable award'; END IF;
 IF OLD.state IN ('paid','released') THEN RAISE EXCEPTION 'award already settled'; END IF;
 IF OLD.state='reserved' AND NEW.state NOT IN ('reserved','paid','deferred_rent','released') THEN RAISE EXCEPTION 'invalid award transition'; END IF;
 IF OLD.state='planned' AND NEW.state='paid' THEN RAISE EXCEPTION 'unfunded award cannot be paid'; END IF;
 NEW.state_version=OLD.state_version+1; RETURN NEW; END $$;
CREATE TRIGGER immutable_award BEFORE UPDATE ON reward_awards FOR EACH ROW EXECUTE FUNCTION reward_award_immutable();

CREATE TABLE reward_lot_credits (
 cycle_id text NOT NULL, leaf_index integer NOT NULL, lot_id text NOT NULL REFERENCES reward_lots(id),
 credit_usd reward_usd NOT NULL CHECK(credit_usd>0), PRIMARY KEY(cycle_id,leaf_index,lot_id),
 FOREIGN KEY(cycle_id,leaf_index) REFERENCES reward_awards(cycle_id,leaf_index)
);
CREATE TRIGGER immutable_lot_credits BEFORE UPDATE OR DELETE ON reward_lot_credits FOR EACH ROW EXECUTE FUNCTION reward_immutable();

-- ---------- buyback / burn ----------
CREATE TABLE reward_buyback_jobs (
 id uuid PRIMARY KEY, source_mint text NOT NULL REFERENCES reward_coins(mint), source_cycle_id text REFERENCES reward_cycles(id),
 target_mint text NOT NULL, target_token_program text NOT NULL, config_version bigint NOT NULL,
 budget_lamports reward_uint NOT NULL CHECK(budget_lamports>0),
 state text NOT NULL CHECK(state IN ('reserved','quoting','deferred','purchase_submitted','purchased_pending_burn','burn_submitted','burned','failed_action_required')),
 route text CHECK(route IN ('pump-curve','pump-amm')), market text, inventory_account text,
 max_slippage_bps integer NOT NULL, max_impact_bps integer NOT NULL, quote jsonb, min_out_raw reward_uint,
 spent_lamports reward_uint, acquired_raw reward_uint, burned_raw reward_uint,
 purchase_signature text UNIQUE, purchase_slot bigint, burn_signature text UNIQUE, burn_slot bigint,
 evidence jsonb NOT NULL DEFAULT '{}', reason text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_mint,source_cycle_id), CHECK(source_mint<>target_mint),
 CHECK(state NOT IN ('purchased_pending_burn','burn_submitted','burned') OR (purchase_signature IS NOT NULL AND acquired_raw>0)),
 CHECK(state<>'burned' OR (burn_signature IS NOT NULL AND burned_raw=acquired_raw))
);
CREATE FUNCTION reward_buyback_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.target_mint<>OLD.target_mint OR NEW.budget_lamports<>OLD.budget_lamports OR NEW.source_mint<>OLD.source_mint OR NEW.config_version<>OLD.config_version THEN RAISE EXCEPTION 'buyback job target and budget are immutable'; END IF;
 IF OLD.purchase_signature IS NOT NULL AND NEW.purchase_signature IS DISTINCT FROM OLD.purchase_signature THEN RAISE EXCEPTION 'purchase evidence is immutable'; END IF;
 IF OLD.state IN ('purchased_pending_burn','burn_submitted') AND NEW.state NOT IN ('purchased_pending_burn','burn_submitted','burned','failed_action_required') THEN RAISE EXCEPTION 'a purchased job may only burn'; END IF;
 IF OLD.state='burned' THEN RAISE EXCEPTION 'burned job is final'; END IF;
 NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER buyback_guard BEFORE UPDATE ON reward_buyback_jobs FOR EACH ROW EXECUTE FUNCTION reward_buyback_guard();

-- ---------- jobs, leases, chain attempts ----------
ALTER TABLE reward_jobs
 ADD COLUMN idempotency_key text, ADD COLUMN resource text, ADD COLUMN next_retry_at timestamptz,
 ADD COLUMN last_error_code text, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX reward_jobs_idempotency ON reward_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Durable row leases: safe behind a transaction pooler (no session advisory locks).
CREATE TABLE reward_leases (
 resource text PRIMARY KEY, owner text NOT NULL, lease_until timestamptz NOT NULL, fencing bigint NOT NULL DEFAULT 1,
 acquired_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE reward_chain_attempts
 ADD COLUMN intent_id uuid, ADD COLUMN kind text, ADD COLUMN mint text, ADD COLUMN signer_role text,
 ADD COLUMN submitted_at timestamptz, ADD COLUMN finalized_at timestamptz, ADD COLUMN finalized_slot bigint, ADD COLUMN error_code text;
CREATE TABLE reward_intents (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('launch','activation','primary_funding','third_party_credit','round_fund','payout','collection','buyback_purchase','buyback_burn','setup')),
 mint text, cycle_id text, job text, namespace text NOT NULL,
 body jsonb NOT NULL, body_hash text NOT NULL, amount_lamports reward_uint, signer_role text NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','awaiting_signature','submitted','finalized','expired','canceled','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kind,job)
);

-- ---------- launch attempts and consent ----------
ALTER TABLE reward_launch_attempts
 ADD COLUMN user_id uuid, ADD COLUMN idempotency_key text, ADD COLUMN namespace text NOT NULL DEFAULT 'production',
 ADD COLUMN name text, ADD COLUMN symbol text, ADD COLUMN image_uri text, ADD COLUMN initial_buy_lamports reward_uint NOT NULL DEFAULT 0,
 ADD COLUMN intake text, ADD COLUMN primary_target_mint text, ADD COLUMN policy_version text REFERENCES reward_policies(version),
 ADD COLUMN activation_state text NOT NULL DEFAULT 'not_started' CHECK(activation_state IN ('not_started','created_pending_activation','activating','active','failed_action_required'));
CREATE UNIQUE INDEX reward_launch_idempotency ON reward_launch_attempts(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE reward_challenges
 ADD COLUMN user_id uuid, ADD COLUMN action text, ADD COLUMN domain text, ADD COLUMN payload_hash text;

-- ---------- identity and roles (server-controlled) ----------
CREATE TABLE reward_admin_wallets (
 wallet text PRIMARY KEY, label text NOT NULL, added_by text NOT NULL, added_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz, revoked_by text
);
CREATE TABLE reward_allowed_auth_domains (domain text PRIMARY KEY, note text NOT NULL);

-- ---------- structured logs, health, storage references ----------
CREATE TABLE reward_logs (
 id bigserial PRIMARY KEY, timestamp_utc timestamptz NOT NULL DEFAULT now(),
 severity text NOT NULL CHECK(severity IN ('debug','info','warn','error','critical')),
 component text NOT NULL, event_type text NOT NULL, namespace text NOT NULL DEFAULT 'production',
 mint text, cycle_id text, job_id text, request_id text, safe_message text NOT NULL, error_code text,
 retry_count integer NOT NULL DEFAULT 0, transaction_signature text, finalized_slot bigint,
 safe_metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX reward_logs_time ON reward_logs(timestamp_utc DESC);
CREATE INDEX reward_logs_filter ON reward_logs(mint,cycle_id,severity,component,timestamp_utc DESC);
CREATE TRIGGER immutable_logs BEFORE UPDATE OR DELETE ON reward_logs FOR EACH ROW EXECUTE FUNCTION reward_immutable();

CREATE TABLE reward_health (
 component text PRIMARY KEY, status text NOT NULL CHECK(status IN ('ok','degraded','down','unconfigured')),
 detail jsonb NOT NULL DEFAULT '{}', heartbeat_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_assets (
 hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'), kind text NOT NULL CHECK(kind IN ('image','metadata','manifest','evidence')),
 bucket text NOT NULL, path text NOT NULL, mime text NOT NULL, bytes integer NOT NULL, public_url text,
 created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(bucket,path)
);
CREATE TRIGGER immutable_assets BEFORE UPDATE OR DELETE ON reward_assets FOR EACH ROW EXECUTE FUNCTION reward_immutable();

-- ---------- public projections (sanitized, monotonically revised) ----------
CREATE TABLE reward_public_tokens (
 mint text PRIMARY KEY, namespace text NOT NULL, kind text NOT NULL, name text, symbol text, image_uri text,
 creator_wallet text, launch_time bigint, decimals integer, supply_definition text, supply_raw reward_uint,
 price_usd_pico numeric(40,0), price_updated_at timestamptz, market_cap_usd_pico numeric(40,0),
 market_cap_kind text CHECK(market_cap_kind IN ('market_cap','fdv')), price_source text,
 reward_status text NOT NULL, next_cycle_at bigint, paid_lamports reward_uint NOT NULL DEFAULT 0,
 burned_primary_raw reward_uint NOT NULL DEFAULT 0, pending_buyback_lamports reward_uint NOT NULL DEFAULT 0,
 pinned boolean NOT NULL DEFAULT false, test boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reward_public_tokens_list ON reward_public_tokens(namespace,pinned DESC,launch_time DESC);
CREATE TABLE reward_public_cycles (
 mint text NOT NULL, cycle_number bigint NOT NULL, state text NOT NULL, cutoff_time bigint NOT NULL, scheduled_end bigint NOT NULL,
 total_lamports reward_uint, recipients integer, submitted_at timestamptz, finalized_at timestamptz,
 revision bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(mint,cycle_number)
);
CREATE FUNCTION reward_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' THEN NEW.revision=OLD.revision+1; END IF; NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER public_tokens_revision BEFORE INSERT OR UPDATE ON reward_public_tokens FOR EACH ROW EXECUTE FUNCTION reward_revision();
CREATE TRIGGER public_cycles_revision BEFORE INSERT OR UPDATE ON reward_public_cycles FOR EACH ROW EXECUTE FUNCTION reward_revision();

INSERT INTO reward_schema_migrations(version) VALUES(5);
COMMIT;
