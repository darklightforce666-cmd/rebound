BEGIN;
-- Site settings managed from the admin dashboard (one row). Public, non-secret values only:
-- whether the site is open without the preview password, the REBOUND token shown across the site
-- (and used for its chart), the dev fee wallet it is funded from, and the Privy App ID (public).
-- Everyone may read it (the page subscribes through Realtime); only the API role writes it, and the
-- API only does so for an administrator with a one-time signed consent.
CREATE TABLE reward_site (
 id smallint PRIMARY KEY DEFAULT 1 CHECK(id=1),
 site_open boolean NOT NULL DEFAULT false,
 primary_mint text CHECK(primary_mint IS NULL OR primary_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 primary_name text CHECK(primary_name IS NULL OR length(primary_name)<=64),
 primary_symbol text CHECK(primary_symbol IS NULL OR length(primary_symbol)<=16),
 fee_wallet text CHECK(fee_wallet IS NULL OR fee_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 namespace text NOT NULL DEFAULT 'production' CHECK(namespace IN ('production','mainnet_test')),
 privy_app_id text CHECK(privy_app_id IS NULL OR privy_app_id ~ '^[A-Za-z0-9_-]{8,64}$'),
 updated_by text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO reward_site(id) VALUES(1) ON CONFLICT DO NOTHING;
SELECT reward_secure_new_tables();
GRANT SELECT ON reward_site TO anon, authenticated;
CREATE POLICY site_read ON reward_site FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT, UPDATE(site_open,primary_mint,primary_name,primary_symbol,fee_wallet,namespace,privy_app_id,updated_by,updated_at) ON reward_site TO rebound_api;
GRANT SELECT ON reward_site TO rebound_indexer, rebound_scheduler, rebound_verifier;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE rebound.reward_site;
 END IF;
END $$;
INSERT INTO reward_schema_migrations(version) VALUES(11);
COMMIT;
