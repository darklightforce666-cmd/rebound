BEGIN;
CREATE TABLE reward_position_views(mint text NOT NULL REFERENCES reward_coins(mint),wallet text NOT NULL,checked_slot bigint NOT NULL,checked_time bigint NOT NULL,view jsonb NOT NULL,PRIMARY KEY(mint,wallet));
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON reward_audit FOR EACH ROW EXECUTE FUNCTION reward_immutable();
CREATE FUNCTION reward_auth_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.signature<>OLD.signature OR NEW.evidence IS DISTINCT FROM OLD.evidence OR NEW.mint<>OLD.mint OR NEW.wallet<>OLD.wallet OR NEW.position_version<>OLD.position_version THEN RAISE EXCEPTION 'immutable eligibility authorization'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_authorization BEFORE UPDATE ON reward_authorizations FOR EACH ROW EXECUTE FUNCTION reward_auth_immutable();
INSERT INTO reward_schema_migrations(version) VALUES(3);
COMMIT;
