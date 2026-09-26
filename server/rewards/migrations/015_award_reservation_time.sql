BEGIN;
-- Review fix (2026-09-27): a fee-wallet budget counts awards by WHEN THEY WERE RESERVED, not by when their
-- round row was created, so a round created before a budget measurement can never escape it.
ALTER TABLE reward_awards ADD COLUMN reserved_at timestamptz;
UPDATE reward_awards SET reserved_at=now() WHERE state IN ('reserved','paid','deferred_rent') AND reserved_at IS NULL;
CREATE INDEX reward_awards_reserved_at ON reward_awards(reserved_at) WHERE reserved_at IS NOT NULL;
INSERT INTO reward_schema_migrations(version) VALUES(15);
COMMIT;
