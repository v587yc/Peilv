BEGIN;

ALTER TABLE odds_snapshots ADD COLUMN IF NOT EXISTS hash_version TEXT NOT NULL DEFAULT 'legacy-json-v1';
ALTER TABLE odds_snapshots ADD COLUMN IF NOT EXISTS canonical_content_hash TEXT;
ALTER TABLE odds_snapshots DROP CONSTRAINT IF EXISTS odds_snapshots_hash_contract_check;
ALTER TABLE odds_snapshots ADD CONSTRAINT odds_snapshots_hash_contract_check CHECK (
  (hash_version = 'legacy-json-v1' AND canonical_content_hash IS NULL)
  OR (
    hash_version = 'canonical-json-v2'
    AND canonical_content_hash IS NOT NULL
    AND canonical_content_hash ~ '^[0-9a-f]{64}$'
    AND content_hash = canonical_content_hash
  )
);
CREATE INDEX IF NOT EXISTS odds_snapshots_strategy_lab_evidence_idx
  ON odds_snapshots(match_id, match_date, company_id, market_type, snapshot_type, source_observed_at, collected_at, hash_version);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM strategy_lab_snapshot_items WHERE role <> 'current') THEN
    RAISE EXCEPTION '0022 preflight failed: snapshot item roles must all be current';
  END IF;
  IF EXISTS (
    SELECT 1 FROM strategy_lab_snapshot_items GROUP BY snapshot_set_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0022 preflight failed: duplicate current snapshot items';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM strategy_lab_snapshot_sets s
    LEFT JOIN strategy_lab_snapshot_items i ON i.snapshot_set_id = s.id
    GROUP BY s.id, s.status
     HAVING (s.status IN ('ready', 'partial') AND count(i.snapshot_set_id) <> 1)
        OR (s.status IN ('missing', 'insufficient', 'invalid') AND count(i.snapshot_set_id) <> 0)
  ) THEN
    RAISE EXCEPTION '0022 preflight failed: snapshot status/evidence cardinality is inconsistent';
  END IF;
END;
$$;

ALTER TABLE strategy_lab_snapshot_items DROP CONSTRAINT IF EXISTS strategy_lab_snapshot_items_role_check;
ALTER TABLE strategy_lab_snapshot_items
  ADD CONSTRAINT strategy_lab_snapshot_items_role_check CHECK (role = 'current');
CREATE UNIQUE INDEX IF NOT EXISTS strategy_lab_snapshot_items_one_current_unique
  ON strategy_lab_snapshot_items(snapshot_set_id);

CREATE OR REPLACE FUNCTION strategy_lab_validate_snapshot_item_asof()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  snapshot_set public.strategy_lab_snapshot_sets%ROWTYPE;
  source_snapshot public.odds_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO snapshot_set FROM public.strategy_lab_snapshot_sets WHERE id = NEW.snapshot_set_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot set is unavailable'; END IF;
  SELECT * INTO source_snapshot FROM public.odds_snapshots WHERE id = NEW.odds_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'referenced odds snapshot is unavailable'; END IF;
  IF source_snapshot.match_id <> snapshot_set.match_id OR source_snapshot.match_date <> snapshot_set.match_date THEN
    RAISE EXCEPTION 'snapshot item match identity mismatch';
  END IF;
  IF NEW.company_id <> source_snapshot.company_id OR NEW.market_type <> source_snapshot.market_type
     OR NEW.snapshot_type <> source_snapshot.snapshot_type
     OR NEW.source_observed_at IS DISTINCT FROM source_snapshot.source_observed_at
     OR NEW.collected_at IS DISTINCT FROM source_snapshot.collected_at THEN
    RAISE EXCEPTION 'snapshot item evidence mismatch';
  END IF;
  IF snapshot_set.dataset_mode = 'strict_asof' AND (
    NEW.source_observed_at IS NULL OR NEW.source_observed_at > snapshot_set.checkpoint_at
    OR NEW.collected_at > snapshot_set.checkpoint_at
    OR source_snapshot.hash_version <> 'canonical-json-v2'
    OR source_snapshot.canonical_content_hash IS NULL
    OR source_snapshot.content_hash <> source_snapshot.canonical_content_hash
  ) THEN
    RAISE EXCEPTION 'strict_asof evidence contract rejected';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION strategy_lab_validate_snapshot_item_completeness()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  target_id uuid;
  snapshot_status text;
  item_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'strategy_lab_snapshot_sets' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW.snapshot_set_id;
  END IF;
  SELECT status INTO snapshot_status FROM public.strategy_lab_snapshot_sets WHERE id = target_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot set is unavailable'; END IF;
  SELECT count(*) INTO item_count FROM public.strategy_lab_snapshot_items WHERE snapshot_set_id = target_id;
  IF snapshot_status IN ('ready', 'partial') AND item_count <> 1 THEN
    RAISE EXCEPTION 'ready or partial snapshot requires exactly one current item';
  END IF;
  IF snapshot_status IN ('missing', 'insufficient', 'invalid') AND item_count <> 0 THEN
    RAISE EXCEPTION 'snapshot status forbids evidence items';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS strategy_lab_snapshot_sets_require_items ON strategy_lab_snapshot_sets;
DROP TRIGGER IF EXISTS strategy_lab_snapshot_items_require_valid_set ON strategy_lab_snapshot_items;
CREATE CONSTRAINT TRIGGER strategy_lab_snapshot_sets_require_items
  AFTER INSERT ON strategy_lab_snapshot_sets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_snapshot_item_completeness();
CREATE CONSTRAINT TRIGGER strategy_lab_snapshot_items_require_valid_set
  AFTER INSERT ON strategy_lab_snapshot_items DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_snapshot_item_completeness();

CREATE OR REPLACE FUNCTION odds_snapshots_reject_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'odds snapshots are append-only';
END;
$$;
DROP TRIGGER IF EXISTS odds_snapshots_append_only ON odds_snapshots;
CREATE TRIGGER odds_snapshots_append_only
  BEFORE UPDATE OR DELETE ON odds_snapshots
  FOR EACH ROW EXECUTE FUNCTION odds_snapshots_reject_mutation();

REVOKE ALL ON FUNCTION strategy_lab_validate_snapshot_item_asof() FROM PUBLIC;
REVOKE ALL ON FUNCTION strategy_lab_validate_snapshot_item_completeness() FROM PUBLIC;
REVOKE ALL ON FUNCTION odds_snapshots_reject_mutation() FROM PUBLIC;

INSERT INTO schema_migrations(version, description)
VALUES ('0022_strategy_lab_snapshot_provider', 'Canonical immutable odds evidence and authoritative current-only Strategy Lab snapshots');
COMMIT;
