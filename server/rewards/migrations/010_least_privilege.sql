BEGIN;
-- Least-privilege follow-up from the independent review (2026-09-26).
-- 1. The private-test spend total is monotonic for service roles: an API credential cannot reset it
--    to defeat the total cap. Only the schema owner (SQL editor / migrations) may reset it.
CREATE OR REPLACE FUNCTION reward_platform_spend_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=rebound,public AS $$ BEGIN
 IF NEW.spent_total_lamports < OLD.spent_total_lamports
    AND current_user <> (SELECT tableowner FROM pg_tables WHERE schemaname='rebound' AND tablename='reward_platform') THEN
  RAISE EXCEPTION 'spent_total_lamports can only be reset by the schema owner' USING ERRCODE='42501';
 END IF;
 RETURN NEW; END $$;
DROP TRIGGER IF EXISTS reward_platform_spend_guard ON reward_platform;
CREATE TRIGGER reward_platform_spend_guard BEFORE UPDATE OF spent_total_lamports ON reward_platform
 FOR EACH ROW EXECUTE FUNCTION reward_platform_spend_guard();
-- 2. Opening-credit columns are written only by the scheduler (it applies the admin's request against
--    the finalized balance). The API keeps mode/signer/status changes.
REVOKE UPDATE(operational_reserve_lamports,opening_balance_lamports,opening_credit_lamports,opening_slot) ON reward_funding_wallets FROM rebound_api;
INSERT INTO reward_schema_migrations(version) VALUES(10);
COMMIT;
