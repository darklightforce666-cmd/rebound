BEGIN;
-- Only the separately governed database owner may record reviewed corrections.
-- Worker roles receive SELECT, never INSERT/UPDATE/DELETE on this table.
CREATE TABLE reward_link_corrections (
 edge_id text PRIMARY KEY REFERENCES reward_wallet_links(id),
 mint text NOT NULL REFERENCES reward_coins(mint), reviewer text NOT NULL,
 reason text NOT NULL CHECK(length(reason)>0), evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_link_correction BEFORE UPDATE OR DELETE ON reward_link_corrections FOR EACH ROW EXECUTE FUNCTION reward_immutable();
CREATE TABLE reward_asset_observations (
 mint text NOT NULL REFERENCES reward_coins(mint), address text NOT NULL,
 slot bigint NOT NULL, asset text NOT NULL CHECK(asset IN ('native-SOL','wrapped-SOL')),
 balance reward_uint NOT NULL, rent reward_uint NOT NULL, liabilities reward_uint,
 classification text NOT NULL, evidence jsonb NOT NULL,
 PRIMARY KEY(mint,address,slot,asset)
);
CREATE TRIGGER immutable_asset_observation BEFORE UPDATE OR DELETE ON reward_asset_observations FOR EACH ROW EXECUTE FUNCTION reward_immutable();
INSERT INTO reward_schema_migrations(version) VALUES(4);
COMMIT;
