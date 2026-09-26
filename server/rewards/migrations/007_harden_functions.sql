BEGIN;
-- Supabase advisor 0011: pin search_path on every REBOUND trigger function. They only compare
-- OLD/NEW and raise, so an empty search_path (pg_catalog is implicit) is sufficient.
ALTER FUNCTION reward_immutable() SET search_path='';
ALTER FUNCTION reward_manifest_immutable() SET search_path='';
ALTER FUNCTION reward_allocation_immutable() SET search_path='';
ALTER FUNCTION reward_auth_immutable() SET search_path='';
ALTER FUNCTION reward_cycle_immutable() SET search_path='';
ALTER FUNCTION reward_award_immutable() SET search_path='';
ALTER FUNCTION reward_buyback_guard() SET search_path='';
ALTER FUNCTION reward_revision() SET search_path='';
SELECT reward_secure_new_tables();
INSERT INTO reward_schema_migrations(version) VALUES(7);
COMMIT;
