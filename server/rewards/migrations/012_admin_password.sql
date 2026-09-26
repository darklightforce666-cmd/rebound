BEGIN;
-- Password access to the admin dashboard (owner request). One row. The password is stored only as a
-- scrypt hash; the first password is created with a one-time setup code whose SHA-256 is stored
-- here (the code itself is handed to the owner out of band and dies on first use). Sessions are
-- HMAC-signed server-side and carry session_version, so changing the password logs out every
-- other session. Repeated failures lock the login for a while. Not readable by anon/authenticated.
CREATE TABLE reward_admin_auth (
 id smallint PRIMARY KEY DEFAULT 1 CHECK(id=1),
 password_hash text CHECK(password_hash IS NULL OR password_hash ~ '^scrypt\$'),
 setup_hash text CHECK(setup_hash IS NULL OR setup_hash ~ '^[0-9a-f]{64}$'),
 setup_expires timestamptz,
 session_version integer NOT NULL DEFAULT 1 CHECK(session_version>0),
 failed integer NOT NULL DEFAULT 0 CHECK(failed>=0),
 locked_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO reward_admin_auth(id) VALUES(1) ON CONFLICT DO NOTHING;
SELECT reward_secure_new_tables();
GRANT SELECT, UPDATE(password_hash,setup_hash,setup_expires,session_version,failed,locked_until,updated_at) ON reward_admin_auth TO rebound_api;
GRANT UPDATE(label) ON reward_admin_wallets TO rebound_api;   -- set admin wallet (relabel on re-add)
INSERT INTO reward_schema_migrations(version) VALUES(12);
COMMIT;
