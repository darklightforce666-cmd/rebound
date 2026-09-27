BEGIN;
-- The portfolio page follows the connected wallet's positions live (owner decision 2026-09-28): holder rows are
-- published to Supabase Realtime (anyone may already read them; subscriptions filter by owner).
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='rebound' AND tablename='reward_public_holders') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE rebound.reward_public_holders;
 END IF;
END $$;
INSERT INTO reward_schema_migrations(version) VALUES(22);
COMMIT;
