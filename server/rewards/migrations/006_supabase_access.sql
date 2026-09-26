BEGIN;
-- Supabase data boundaries (spec §14, §15). All REBOUND objects live in schema "rebound",
-- which is NOT exposed through the Data API. Browsers only read two sanitized projections,
-- their own launch drafts, and (admins) logs/health — always through RLS. Nothing is
-- browser-writable. Server components use separately scoped database roles
-- (scripts/rewards/database-roles.sql); the service-role key is not a runtime credential
-- for financial state.
--
-- Requires the Supabase "auth" schema (auth.uid(), auth.identities) and roles anon/authenticated.
-- Local tests provide an exact emulation: scripts/rewards/supabase-emulation.sql.

INSERT INTO reward_allowed_auth_domains(domain,note) VALUES
 ('rebound.wtf','production site'),('www.rebound.wtf','production site (www)')
ON CONFLICT DO NOTHING;

-- Admin = an authenticated Supabase user whose server-verified Web3 identity
-- (provider_id is set by Supabase Auth after SIWS verification, not by the user) is an
-- explicitly configured, unrevoked REBOUND admin wallet, and whose latest sign-in for
-- that identity was made for a REBOUND domain. user_metadata is never consulted.
CREATE FUNCTION reward_is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(
  SELECT 1 FROM auth.identities i
  JOIN rebound.reward_admin_wallets a ON i.provider_id='web3:solana:'||a.wallet AND a.revoked_at IS NULL
  JOIN rebound.reward_allowed_auth_domains d ON d.domain=i.identity_data->'custom_claims'->>'domain'
  WHERE i.provider='web3' AND i.user_id=auth.uid())
$$;
-- Verified Solana wallets of the calling user (for creator ownership checks).
CREATE FUNCTION reward_user_wallets(uid uuid) RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT substr(i.provider_id,13) FROM auth.identities i WHERE i.user_id=uid AND i.provider='web3' AND i.provider_id LIKE 'web3:solana:%'
$$;

-- Lock everything down first, then open the minimum. Every later migration ends with
-- SELECT reward_secure_new_tables(); so no table is ever created without RLS.
REVOKE ALL ON SCHEMA rebound FROM PUBLIC;
CREATE FUNCTION reward_secure_new_tables() RETURNS integer LANGUAGE plpgsql SET search_path='' AS $$
DECLARE t record; r text; n integer:=0; BEGIN
 FOREACH r IN ARRAY ARRAY['rebound_api','rebound_indexer','rebound_scheduler','rebound_verifier'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',r); END IF;
 END LOOP;
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
          WHERE s.nspname='rebound' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity LOOP
  EXECUTE format('ALTER TABLE rebound.%I ENABLE ROW LEVEL SECURITY',t.relname);
  EXECUTE format('REVOKE ALL ON rebound.%I FROM PUBLIC, anon, authenticated',t.relname);
  -- Server roles (NOLOGIN groups; scripts/rewards/database-roles.sql grants each a distinct
  -- login and the minimum table privileges) get a row policy; their GRANTs, not RLS, limit
  -- what they may change. The schema owner (migrations/operator) is not subject to RLS.
  FOREACH r IN ARRAY ARRAY['rebound_api','rebound_indexer','rebound_scheduler','rebound_verifier'] LOOP
   EXECUTE format('CREATE POLICY %I ON rebound.%I TO %I USING (true) WITH CHECK (true)','server_'||r,t.relname,r);
  END LOOP;
  n:=n+1;
 END LOOP;
 EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA rebound FROM PUBLIC, anon, authenticated';
 EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rebound FROM PUBLIC, anon, authenticated';
 EXECUTE 'GRANT EXECUTE ON FUNCTION rebound.reward_is_admin() TO authenticated';
 RETURN n;
END $$;
SELECT reward_secure_new_tables();
ALTER DEFAULT PRIVILEGES IN SCHEMA rebound REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA rebound REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA rebound REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA rebound TO anon, authenticated;

-- Public, sanitized projections (read-only for everyone).
GRANT SELECT ON reward_public_tokens, reward_public_cycles TO anon, authenticated;
CREATE POLICY public_tokens_read ON reward_public_tokens FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY public_cycles_read ON reward_public_cycles FOR SELECT TO anon, authenticated USING (true);

-- Creators read only their own launch drafts. Writes go through the authenticated API.
GRANT SELECT(id,mint,wallet,state,metadata_uri,metadata_hash,steps,created_at,updated_at,user_id,name,symbol,image_uri,initial_buy_lamports,intake,primary_target_mint,policy_version,activation_state,namespace)
 ON reward_launch_attempts TO authenticated;
CREATE POLICY launch_owner_read ON reward_launch_attempts FOR SELECT TO authenticated USING (user_id=auth.uid());

-- Private admin data.
GRANT SELECT ON reward_logs, reward_health TO authenticated;
CREATE POLICY logs_admin_read ON reward_logs FOR SELECT TO authenticated USING (rebound.reward_is_admin());
CREATE POLICY health_admin_read ON reward_health FOR SELECT TO authenticated USING (rebound.reward_is_admin());

-- Realtime: public projections, creator drafts and admin logs. RLS decides who receives rows.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE rebound.reward_public_tokens, rebound.reward_public_cycles, rebound.reward_logs, rebound.reward_launch_attempts, rebound.reward_health;
 END IF;
END $$;

-- Storage: immutable, content-addressed public token assets; private evidence/manifests.
-- No storage.objects policies are created for anon/authenticated, so browsers cannot
-- upload, overwrite or delete. Uploads are validated by the server API.
DO $$ BEGIN
 IF to_regclass('storage.buckets') IS NOT NULL THEN
  EXECUTE $b$INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES
   ('rebound-token-assets','rebound-token-assets',true,2097152,ARRAY['image/png','image/jpeg','application/json']),
   ('rebound-evidence','rebound-evidence',false,20971520,ARRAY['application/json'])
   ON CONFLICT (id) DO NOTHING$b$;
 END IF;
END $$;

INSERT INTO reward_schema_migrations(version) VALUES(6);
COMMIT;
