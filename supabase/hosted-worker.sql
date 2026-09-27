-- REBOUND hosted worker on Supabase (Edge Function `rebound-worker` + pg_cron). Run as the project owner
-- (SQL editor / Supabase MCP) after migrations 001–014. Idempotent. No secret value appears in this file:
-- random secrets are generated inside the database, and the RPC endpoint is stored by the site's API.

-- 1. The function connects with the injected SUPABASE_DB_URL (postgres) and runs every statement as the
--    matching REBOUND group role (startup option "role"), so per-role privileges still apply.
GRANT rebound_indexer, rebound_scheduler, rebound_verifier TO postgres WITH INHERIT FALSE, SET TRUE;

-- 2. Vault secrets generated in place (never displayed).
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='rebound_worker_cron_token') THEN
  PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'rebound_worker_cron_token','Shared token: pg_cron → rebound-worker');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='rebound_worker_master_key') THEN
  PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'rebound_worker_master_key','Encrypts imported fee-wallet keys at rest (AES-256-GCM)');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='rebound_worker_max_mode') THEN
  PERFORM vault.create_secret('mainnet_test','rebound_worker_max_mode','Execution ceiling of the hosted worker (the platform row still starts in dry_run)');
 END IF;
END $$;

-- 3. The site's API stores its own RPC endpoint for the worker (write-only: it can never read vault).
CREATE OR REPLACE FUNCTION rebound.worker_store_rpc(rpc text, history text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result text:='unchanged'; n text; v text; cur text;
BEGIN
 FOREACH n IN ARRAY ARRAY['rebound_worker_rpc_url','rebound_worker_history_rpc_url'] LOOP
  v:=CASE n WHEN 'rebound_worker_rpc_url' THEN rpc ELSE history END;
  CONTINUE WHEN v IS NULL OR v='';
  -- Only well-known Solana RPC providers: a compromised site API must not be able to point the signing
  -- worker at an RPC that fakes history or balances.
  IF length(v)>500 OR v !~ '^https://([a-z0-9-]+\.)*(alchemy\.com|helius-rpc\.com|quiknode\.pro|rpcpool\.com|syndica\.io|mainnet-beta\.solana\.com)(:[0-9]+)?(/[^\s]*)?$' THEN
   RAISE EXCEPTION 'Not an allowed Solana RPC provider URL'; END IF;
  SELECT decrypted_secret INTO cur FROM vault.decrypted_secrets WHERE name=n;
  IF cur IS NULL THEN PERFORM vault.create_secret(v,n,'Solana RPC for the hosted worker (stored by the site API)'); result:='stored';
  ELSIF cur<>v THEN PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name=n),v); result:='updated'; END IF;
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION rebound.worker_store_rpc(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rebound.worker_store_rpc(text,text) TO rebound_api;

-- 4. Every 20 seconds, two separate bounded passes (the function answers at once and works in the
--    background): the indexer (history → verified events) and the scheduler (positions → rounds → payouts).
--    Separate calls: a slow history pass never delays a round; each has its own time and database budget.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('rebound-worker','rebound-indexer','rebound-scheduler');
SELECT cron.schedule('rebound-indexer','20 seconds',$cron$
 SELECT net.http_post(
  url:='https://zuvefozubbgstyljfxjh.supabase.co/functions/v1/rebound-worker',
  headers:=jsonb_build_object('content-type','application/json','x-rebound-cron',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='rebound_worker_cron_token')),
  body:='{"role":"indexer"}'::jsonb, timeout_milliseconds:=5000)
$cron$);
SELECT cron.schedule('rebound-scheduler','20 seconds',$cron$
 SELECT net.http_post(
  url:='https://zuvefozubbgstyljfxjh.supabase.co/functions/v1/rebound-worker',
  headers:=jsonb_build_object('content-type','application/json','x-rebound-cron',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='rebound_worker_cron_token')),
  body:='{"role":"scheduler"}'::jsonb, timeout_milliseconds:=5000)
$cron$);
