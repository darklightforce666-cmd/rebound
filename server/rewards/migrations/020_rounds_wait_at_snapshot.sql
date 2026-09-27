BEGIN;
-- Rounds never drop a snapshot that is still catching up with the chain (owner decision 2026-09-27): the round
-- waits at its cutoff, the snapshot is taken at the cutoff slot once history is verified, and the payout
-- follows the full lead after that. The schedule itself (start, cutoff, scheduled end) stays immutable; only
-- the payout time (due_at) may move later than the scheduled end.
ALTER TABLE reward_cycles DROP CONSTRAINT reward_cycles_check;
ALTER TABLE reward_cycles ADD CONSTRAINT reward_cycles_check CHECK(cutoff_time<scheduled_end AND cycle_start<cutoff_time AND due_at>=scheduled_end);
INSERT INTO reward_schema_migrations(version) VALUES(20);
COMMIT;
