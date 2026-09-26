BEGIN;
-- (1) Balance-budget funding (owner request, private test on third-party tokens). Instead of
--     "85% of new creator-fee income", the fee wallet commits a fixed share of its CURRENT balance:
--     budget = budget_bps × finalized balance, measured once by the scheduler. Every round deposits
--     at most what is left: budget − (on-chain coin deposits − deposits when the budget was set),
--     and never more than the wallet balance minus a small fee reserve. The admin asks (API writes
--     funding_model/budget_bps/budget_requested_at); the scheduler measures and fixes the numbers.
ALTER TABLE reward_funding_wallets
 ADD COLUMN funding_model text NOT NULL DEFAULT 'income' CHECK(funding_model IN ('income','balance_budget')),
 ADD COLUMN budget_bps integer CHECK(budget_bps IS NULL OR budget_bps BETWEEN 1 AND 10000),
 ADD COLUMN budget_requested_at timestamptz,
 ADD COLUMN budget_balance_lamports reward_uint,
 ADD COLUMN budget_lamports reward_uint,
 ADD COLUMN budget_start_deposits reward_uint,
 ADD COLUMN budget_set_at timestamptz,
 ADD CONSTRAINT funding_budget_shape CHECK(funding_model='income' OR budget_bps IS NOT NULL);

-- (2) Private test: pay every eligible holder of the allowlisted test mints (the recipient allowlist
--     cannot list strangers' wallets). Mint allowlist and all spend caps still apply.
ALTER TABLE reward_platform ADD COLUMN test_any_recipient boolean NOT NULL DEFAULT false;

-- (3) Key inbox: the admin pastes the fee wallet's secret key in the dashboard; the BROWSER encrypts it
--     to the settlement worker's X25519 public key (ECDH + HKDF-SHA256 + AES-256-GCM). The API stores
--     ciphertext it cannot read. The scheduler decrypts it with its private inbox key (a file on the
--     worker host), checks it is exactly the registered fee wallet, re-encrypts it under the signer
--     master key (reward_signers) and wipes the inbox row.
CREATE TABLE reward_worker_keys (
 id smallint PRIMARY KEY DEFAULT 1 CHECK(id=1),
 inbox_public_key text NOT NULL CHECK(inbox_public_key ~ '^[A-Za-z0-9_-]{43}$'),   -- raw X25519, base64url
 worker text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_key_inbox (
 id uuid PRIMARY KEY,
 funding_wallet uuid NOT NULL REFERENCES reward_funding_wallets(id),
 address text NOT NULL,
 inbox_public_key text NOT NULL,
 ephemeral_public_key text, iv text, ciphertext text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','imported','failed')),
 reason text,
 created_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz,
 CHECK(state<>'pending' OR (ephemeral_public_key IS NOT NULL AND iv IS NOT NULL AND ciphertext IS NOT NULL)),
 CHECK(state='pending' OR (ephemeral_public_key IS NULL AND iv IS NULL AND ciphertext IS NULL))
);
CREATE UNIQUE INDEX reward_key_inbox_pending ON reward_key_inbox(funding_wallet) WHERE state='pending';
SELECT reward_secure_new_tables();

GRANT UPDATE(funding_model,budget_bps,budget_requested_at) ON reward_funding_wallets TO rebound_api;
GRANT UPDATE(test_any_recipient) ON reward_platform TO rebound_api;
GRANT SELECT ON reward_worker_keys TO rebound_api, rebound_indexer, rebound_verifier;
GRANT SELECT, INSERT, UPDATE ON reward_worker_keys TO rebound_scheduler;
GRANT SELECT(id,funding_wallet,address,inbox_public_key,state,reason,created_by,created_at,processed_at) ON reward_key_inbox TO rebound_api, rebound_indexer, rebound_verifier;
GRANT INSERT ON reward_key_inbox TO rebound_api;
GRANT SELECT, UPDATE ON reward_key_inbox TO rebound_scheduler;
GRANT INSERT ON reward_signers TO rebound_scheduler;
GRANT UPDATE(status,revoked_at,ciphertext,iv,auth_tag,storage,external_reference) ON reward_signers TO rebound_scheduler;
INSERT INTO reward_schema_migrations(version) VALUES(13);
COMMIT;
