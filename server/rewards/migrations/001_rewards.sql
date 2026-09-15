BEGIN;
CREATE TABLE IF NOT EXISTS reward_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE DOMAIN reward_uint AS numeric(20,0) CHECK(VALUE>=0 AND VALUE<=18446744073709551615);
CREATE TABLE reward_deployments (
 id text PRIMARY KEY, program text NOT NULL UNIQUE, genesis text NOT NULL, policy_hash text NOT NULL,
 operations text NOT NULL, publisher text NOT NULL, verifier text NOT NULL, guardian text NOT NULL,
 upgrade_authority text NOT NULL, governance_evidence jsonb NOT NULL DEFAULT '{}',
 activation_evidence jsonb NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(publisher<>verifier AND operations<>verifier)
);
CREATE TABLE reward_coins (
 mint text PRIMARY KEY, deployment text NOT NULL REFERENCES reward_deployments(id), launcher text NOT NULL,
 intake text NOT NULL UNIQUE, treasury text NOT NULL UNIQUE, sharing_config text NOT NULL UNIQUE,
 reward_asset text NOT NULL DEFAULT 'native-SOL' CHECK(reward_asset='native-SOL'),
 policy_hash text NOT NULL, status text NOT NULL CHECK(status IN ('preparing','verifying','active','blocked','paused')),
 launch_slot bigint, activation_slot bigint, activation_evidence jsonb, current_creator text,
 last_finalized_slot bigint, blocked_reason text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_launch_attempts (
 id uuid PRIMARY KEY, mint text UNIQUE, wallet text NOT NULL, state text NOT NULL,
 request_hash text NOT NULL, metadata_uri text NOT NULL, metadata_hash text NOT NULL,
 steps jsonb NOT NULL DEFAULT '[]', evidence jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(wallet,request_hash)
);
CREATE TABLE reward_raw_blocks (
 genesis text NOT NULL, slot bigint NOT NULL, blockhash text NOT NULL, parent_slot bigint NOT NULL,
 block_time bigint NOT NULL, payload jsonb NOT NULL, digest text NOT NULL, parser_version text NOT NULL,
 indexed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(genesis,slot), UNIQUE(genesis,blockhash)
);
CREATE TABLE reward_events (
 id text PRIMARY KEY, mint text REFERENCES reward_coins(mint), signature text NOT NULL, instruction_path text NOT NULL,
 event_index integer NOT NULL, slot bigint NOT NULL, transaction_index integer NOT NULL, execution_order integer NOT NULL,
 kind text NOT NULL, owner text, data jsonb NOT NULL, raw_digest text NOT NULL, parser_version text NOT NULL,
 finalized boolean NOT NULL CHECK(finalized), UNIQUE(signature,instruction_path,event_index,mint)
);
CREATE INDEX reward_events_mint_slot ON reward_events(mint,slot,transaction_index,execution_order);
CREATE TABLE reward_token_ownership (
 address text NOT NULL, mint text NOT NULL REFERENCES reward_coins(mint), owner text NOT NULL,
 start_event text NOT NULL REFERENCES reward_events(id), start_slot bigint NOT NULL,
 end_event text REFERENCES reward_events(id), end_slot bigint, PRIMARY KEY(address,start_event)
);
CREATE UNIQUE INDEX reward_current_owner ON reward_token_ownership(address) WHERE end_event IS NULL;
CREATE TABLE reward_positions (
 mint text NOT NULL REFERENCES reward_coins(mint), wallet text NOT NULL, version bigint NOT NULL DEFAULT 0,
 paid reward_uint NOT NULL DEFAULT 0, reserved reward_uint NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'indexing', latest_check_slot bigint, reason text,
 PRIMARY KEY(mint,wallet)
);
CREATE TABLE reward_purchase_lots (
 id text PRIMARY KEY REFERENCES reward_events(id), mint text NOT NULL REFERENCES reward_coins(mint), wallet text NOT NULL,
 quantity reward_uint NOT NULL, cost reward_uint NOT NULL, quote_asset text NOT NULL CHECK(quote_asset='native-SOL'),
 bought_at bigint NOT NULL, matures_at bigint NOT NULL, slot bigint NOT NULL,
 continuously_held boolean NOT NULL DEFAULT true, status text NOT NULL,
 policy_hash text NOT NULL, reason text, provenance jsonb NOT NULL,
 FOREIGN KEY(mint,wallet) REFERENCES reward_positions(mint,wallet)
);
CREATE INDEX reward_lots_wallet ON reward_purchase_lots(mint,wallet,matures_at);
CREATE TABLE reward_disqualifications (
 mint text NOT NULL REFERENCES reward_coins(mint), wallet text NOT NULL, event text NOT NULL REFERENCES reward_events(id),
 slot bigint NOT NULL, kind text NOT NULL CHECK(kind IN ('sale','transfer_exit','liquidity_exit','bridge_exit','burn','owner_change')),
 PRIMARY KEY(mint,wallet)
);
CREATE TABLE reward_wallet_links (
 id text PRIMARY KEY, mint text NOT NULL REFERENCES reward_coins(mint), source text NOT NULL, recipient text NOT NULL,
 purchase text NOT NULL REFERENCES reward_purchase_lots(id), status text NOT NULL CHECK(status IN ('supported','ambiguous','revoked')),
 policy_hash text NOT NULL, evidence jsonb NOT NULL, correction jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_services(address text PRIMARY KEY, classification text NOT NULL, evidence jsonb NOT NULL, verified_at timestamptz NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE reward_price_observations (
 mint text NOT NULL REFERENCES reward_coins(mint), slot bigint NOT NULL, observed_at bigint NOT NULL,
 market text NOT NULL, base_reserve reward_uint NOT NULL, real_quote reward_uint NOT NULL,
 virtual_quote numeric(40,0) NOT NULL, evidence jsonb NOT NULL, continuity_verified boolean NOT NULL DEFAULT false,
 PRIMARY KEY(mint,slot,market)
);
CREATE TABLE reward_receipts (
 id text PRIMARY KEY, mint text NOT NULL REFERENCES reward_coins(mint), event text NOT NULL UNIQUE REFERENCES reward_events(id),
 signature text NOT NULL, instruction_path text NOT NULL, amount reward_uint NOT NULL, asset text NOT NULL CHECK(asset='native-SOL'),
 source_slot bigint NOT NULL, state text NOT NULL CHECK(state IN ('observed','verified','submitted','credited','held')),
 attestation jsonb, onchain_receipt text UNIQUE, credit_signature text, UNIQUE(mint,signature,instruction_path)
);
CREATE TABLE reward_accounts (
 mint text PRIMARY KEY REFERENCES reward_coins(mint), receipts reward_uint NOT NULL DEFAULT 0,
 unallocated reward_uint NOT NULL DEFAULT 0, reserved reward_uint NOT NULL DEFAULT 0, paid reward_uint NOT NULL DEFAULT 0,
 operations_payable reward_uint NOT NULL DEFAULT 0, operations_paid reward_uint NOT NULL DEFAULT 0,
 split_remainder integer NOT NULL DEFAULT 0 CHECK(split_remainder BETWEEN 0 AND 99),
 rent reward_uint NOT NULL DEFAULT 0, unrelated_deposits reward_uint NOT NULL DEFAULT 0, chain_slot bigint,
 CHECK(receipts=unallocated+reserved+paid+operations_payable+operations_paid)
);
CREATE TABLE reward_journal (
 id text PRIMARY KEY, mint text NOT NULL REFERENCES reward_coins(mint), kind text NOT NULL,
 reference text NOT NULL, entries jsonb NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
 chain_signature text NOT NULL, chain_slot bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(mint,kind,reference)
);
CREATE TABLE reward_rounds (
 mint text NOT NULL REFERENCES reward_coins(mint), round_id bigint NOT NULL, cutoff_slot bigint NOT NULL, cutoff_time bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('preparing','verified','reserved','delivering','completed','blocked')),
 root text, manifest_hash text, manifest jsonb, total reward_uint NOT NULL DEFAULT 0,
 verification jsonb, funding_signature text, reason text, PRIMARY KEY(mint,round_id)
);
CREATE TABLE reward_allocations (
 mint text NOT NULL, round_id bigint NOT NULL, leaf_index integer NOT NULL, wallet text NOT NULL,
 maximum reward_uint NOT NULL, paid reward_uint NOT NULL DEFAULT 0, released reward_uint NOT NULL DEFAULT 0,
 active reward_uint NOT NULL, proof jsonb NOT NULL, lot_shares jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','held','paid','reduced','canceled')),
 state_version bigint NOT NULL DEFAULT 0, check_evidence jsonb, settlement_signature text,
 PRIMARY KEY(mint,round_id,leaf_index), FOREIGN KEY(mint,round_id) REFERENCES reward_rounds(mint,round_id),
 FOREIGN KEY(mint,wallet) REFERENCES reward_positions(mint,wallet),
 CHECK(maximum=paid+released+active), CHECK((state IN ('reserved','held') AND active=maximum AND paid=0 AND released=0) OR (state IN ('paid','reduced','canceled') AND active=0))
);
CREATE TABLE reward_payment_attempts (
 id uuid PRIMARY KEY, mint text NOT NULL, round_id bigint NOT NULL, leaf_index integer NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','broadcast','uncertain','finalized','expired','failed')),
 signature text UNIQUE NOT NULL, transaction_bytes text NOT NULL, last_valid_block_height bigint NOT NULL,
 authorization_payload jsonb NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(mint,round_id,leaf_index) REFERENCES reward_allocations(mint,round_id,leaf_index)
);
CREATE UNIQUE INDEX reward_one_live_attempt ON reward_payment_attempts(mint,round_id,leaf_index) WHERE state IN ('prepared','broadcast','uncertain');
CREATE TABLE reward_checkpoints (
 name text PRIMARY KEY, through_slot bigint NOT NULL, through_time bigint NOT NULL, start_slot bigint NOT NULL,
 complete boolean NOT NULL DEFAULT false, parser_version text NOT NULL, digest text NOT NULL, incident jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_jobs (
 id text PRIMARY KEY, mint text REFERENCES reward_coins(mint), kind text NOT NULL, due_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending', lease_owner text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, checkpoint jsonb NOT NULL DEFAULT '{}', error text
);
CREATE INDEX reward_jobs_due ON reward_jobs(state,due_at);
CREATE TABLE reward_audit (
 id bigserial PRIMARY KEY, kind text NOT NULL, mint text, wallet text, actor text NOT NULL, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_challenges (id uuid PRIMARY KEY,wallet text NOT NULL,message text NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz);
CREATE FUNCTION reward_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable reward evidence'; END $$;
CREATE TRIGGER immutable_confirmed_exit BEFORE UPDATE OR DELETE ON reward_disqualifications FOR EACH ROW EXECUTE FUNCTION reward_immutable();
CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON reward_journal FOR EACH ROW EXECUTE FUNCTION reward_immutable();
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON reward_events FOR EACH ROW EXECUTE FUNCTION reward_immutable();
CREATE TRIGGER immutable_raw_blocks BEFORE UPDATE OR DELETE ON reward_raw_blocks FOR EACH ROW EXECUTE FUNCTION reward_immutable();
CREATE FUNCTION reward_manifest_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.manifest_hash IS NOT NULL AND (NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash OR NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.root IS DISTINCT FROM OLD.root OR NEW.total<>OLD.total) THEN RAISE EXCEPTION 'immutable funded manifest'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_manifest BEFORE UPDATE ON reward_rounds FOR EACH ROW EXECUTE FUNCTION reward_manifest_immutable();
CREATE FUNCTION reward_allocation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.maximum<>OLD.maximum OR NEW.wallet<>OLD.wallet OR NEW.proof IS DISTINCT FROM OLD.proof OR NEW.lot_shares IS DISTINCT FROM OLD.lot_shares THEN RAISE EXCEPTION 'immutable conditional allocation'; END IF;
 IF OLD.active=0 THEN RAISE EXCEPTION 'allocation already settled'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_allocation BEFORE UPDATE ON reward_allocations FOR EACH ROW EXECUTE FUNCTION reward_allocation_immutable();
INSERT INTO reward_schema_migrations(version) VALUES(1);
COMMIT;
