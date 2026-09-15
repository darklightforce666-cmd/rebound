BEGIN;
CREATE TABLE reward_authorizations (
 id text PRIMARY KEY, mint text NOT NULL REFERENCES reward_coins(mint), wallet text NOT NULL,
 round_id bigint NOT NULL, leaf_index integer NOT NULL, position_version bigint NOT NULL,
 funding_epoch bigint NOT NULL, checked_through bigint NOT NULL, expires_slot bigint NOT NULL,
 payload jsonb NOT NULL, signature text NOT NULL, evidence jsonb NOT NULL, state text NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','expired','settled')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reward_current_authorization ON reward_authorizations(mint,wallet,position_version,funding_epoch) WHERE state='issued';
CREATE TABLE reward_fee_accruals (
 id text PRIMARY KEY REFERENCES reward_events(id), mint text NOT NULL REFERENCES reward_coins(mint),
 source_vault text NOT NULL, asset text NOT NULL CHECK(asset IN ('native-SOL','wrapped-SOL')),
 amount reward_uint NOT NULL, collected reward_uint NOT NULL DEFAULT 0, slot bigint NOT NULL,
 CHECK(collected<=amount)
);
CREATE TABLE reward_receipt_sources (
 receipt text NOT NULL REFERENCES reward_receipts(id), accrual text NOT NULL REFERENCES reward_fee_accruals(id),
 amount reward_uint NOT NULL, PRIMARY KEY(receipt,accrual)
);
CREATE TABLE reward_nonce_uses (nonce text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE reward_rate_limits (bucket text NOT NULL,window_start bigint NOT NULL,requests integer NOT NULL,PRIMARY KEY(bucket,window_start));
CREATE TABLE reward_chain_attempts (
 id uuid PRIMARY KEY, job text NOT NULL, state text NOT NULL CHECK(state IN ('prepared','broadcast','uncertain','finalized','expired','failed')),
 signature text UNIQUE NOT NULL, transaction_bytes text NOT NULL, last_valid_block_height bigint NOT NULL,
 context jsonb NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reward_one_chain_attempt ON reward_chain_attempts(job) WHERE state IN ('prepared','broadcast','uncertain');
INSERT INTO reward_schema_migrations(version) VALUES(2);
COMMIT;
