-- Strategy Lab Phase 4: immutable match-result revisions and trusted calculator evidence.

DO $$ BEGIN
  IF to_regclass('public.strategy_lab_match_result_revisions') IS NOT NULL
     OR EXISTS (SELECT 1 FROM schema_migrations WHERE version='0023_strategy_lab_trusted_settlement') THEN
    RAISE EXCEPTION '0023 already applied or partially present';
  END IF;
END $$;

CREATE TABLE strategy_lab_match_result_revisions (
  id UUID PRIMARY KEY,
  source_match_result_id INTEGER NOT NULL REFERENCES match_results(id),
  match_id VARCHAR(20) NOT NULL,
  match_date VARCHAR(8) NOT NULL,
  status TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  score_source TEXT NOT NULL,
  source_observed_at TIMESTAMPTZ NOT NULL,
  source_settled_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  supersedes UUID REFERENCES strategy_lab_match_result_revisions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_lab_match_result_revisions_identity_unique UNIQUE(match_id,match_date,revision),
  CONSTRAINT strategy_lab_match_result_revisions_source_hash_unique UNIQUE(source_match_result_id,content_hash),
  CONSTRAINT strategy_lab_match_result_revisions_supersedes_unique UNIQUE(supersedes),
  CONSTRAINT strategy_lab_match_result_revisions_date_check CHECK(match_date~'^[0-9]{8}$' AND to_char(to_date(match_date,'YYYYMMDD'),'YYYYMMDD')=match_date),
  CONSTRAINT strategy_lab_match_result_revisions_status_check CHECK(status IN('finished','pending','special')),
  CONSTRAINT strategy_lab_match_result_revisions_score_check CHECK(
    (status='finished' AND home_score BETWEEN 0 AND 99 AND away_score BETWEEN 0 AND 99 AND source_settled_at IS NOT NULL)
    OR (status IN('pending','special') AND home_score IS NULL AND away_score IS NULL AND source_settled_at IS NULL)),
  CONSTRAINT strategy_lab_match_result_revisions_hash_check CHECK(content_hash~'^[a-f0-9]{64}$'),
  CONSTRAINT strategy_lab_match_result_revisions_revision_check CHECK(revision>0),
  CONSTRAINT strategy_lab_match_result_revisions_time_check CHECK(source_observed_at<=source_updated_at AND (source_settled_at IS NULL OR source_observed_at<=source_settled_at))
);

ALTER TABLE strategy_lab_predictions
  ADD COLUMN evidence_contract_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN execution_cutoff_at TIMESTAMPTZ,
  ADD COLUMN executed_actual_quote_snapshot_id INTEGER REFERENCES odds_snapshots(id),
  ADD COLUMN theoretical_handicap_raw TEXT,
  ADD COLUMN theoretical_handicap_quarter_units INTEGER,
  ADD COLUMN theoretical_selected_water NUMERIC(7,6);
ALTER TABLE strategy_lab_predictions ADD CONSTRAINT strategy_lab_predictions_evidence_contract_check CHECK(evidence_contract_version IN(1,2));
ALTER TABLE strategy_lab_predictions ADD CONSTRAINT strategy_lab_predictions_v2_physical_check CHECK(
  (evidence_contract_version=1 AND execution_cutoff_at IS NULL AND executed_actual_quote_snapshot_id IS NULL
    AND theoretical_handicap_raw IS NULL AND theoretical_handicap_quarter_units IS NULL AND theoretical_selected_water IS NULL)
  OR (evidence_contract_version=2 AND decision_status='recommend'
    AND execution_cutoff_at IS NOT NULL AND executed_actual_quote_snapshot_id IS NOT NULL
    AND theoretical_handicap_raw IS NOT NULL AND btrim(theoretical_handicap_raw)<>''
    AND theoretical_handicap_quarter_units BETWEEN -80 AND 80
    AND theoretical_selected_water>0 AND theoretical_selected_water<=5)
  OR (evidence_contract_version=2 AND decision_status<>'recommend'
    AND execution_cutoff_at IS NULL AND executed_actual_quote_snapshot_id IS NULL
    AND theoretical_handicap_raw IS NULL AND theoretical_handicap_quarter_units IS NULL AND theoretical_selected_water IS NULL)
);

ALTER TABLE strategy_lab_settlements
  ADD COLUMN match_result_revision_id UUID REFERENCES strategy_lab_match_result_revisions(id),
  ADD COLUMN calculator_version TEXT,
  ADD COLUMN evidence_hash TEXT,
  ADD COLUMN quote_handicap_raw TEXT,
  ADD COLUMN quote_handicap_quarter_units INTEGER,
  ADD COLUMN quote_selected_water NUMERIC(7,6),
  ADD COLUMN quote_selected_water_millionths INTEGER;
ALTER TABLE strategy_lab_settlements ADD CONSTRAINT strategy_lab_settlements_evidence_hash_check
  CHECK(evidence_hash IS NULL OR evidence_hash~'^[a-f0-9]{64}$');
ALTER TABLE strategy_lab_settlements ADD CONSTRAINT strategy_lab_settlements_calculator_version_check
  CHECK(calculator_version IS NULL OR btrim(calculator_version)<>'');
ALTER TABLE strategy_lab_settlements ADD CONSTRAINT strategy_lab_settlements_physical_quote_check CHECK(
  (calculator_version IS NULL AND quote_handicap_raw IS NULL AND quote_handicap_quarter_units IS NULL
    AND quote_selected_water IS NULL AND quote_selected_water_millionths IS NULL)
  OR (calculator_version IS NOT NULL AND btrim(quote_handicap_raw)<>'' AND quote_handicap_quarter_units BETWEEN -80 AND 80
    AND quote_selected_water>0 AND quote_selected_water<=5 AND quote_selected_water_millionths BETWEEN 1 AND 5000000
    AND quote_selected_water=quote_selected_water_millionths::numeric/1000000));

CREATE FUNCTION strategy_lab_validate_match_result_revision()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source_row match_results%ROWTYPE; previous strategy_lab_match_result_revisions%ROWTYPE;
BEGIN
  SELECT * INTO source_row FROM match_results WHERE id=NEW.source_match_result_id FOR SHARE;
  IF NOT FOUND OR source_row.match_id<>NEW.match_id OR source_row.match_date<>NEW.match_date
     OR source_row.status<>NEW.status OR source_row.home_score IS DISTINCT FROM NEW.home_score
     OR source_row.away_score IS DISTINCT FROM NEW.away_score OR source_row.score_source IS DISTINCT FROM NEW.score_source
     OR source_row.observed_at IS DISTINCT FROM NEW.source_observed_at OR source_row.settled_at IS DISTINCT FROM NEW.source_settled_at
     OR source_row.updated_at IS DISTINCT FROM NEW.source_updated_at THEN RAISE EXCEPTION 'match result revision source mismatch'; END IF;
  IF NEW.revision=1 THEN
    IF NEW.supersedes IS NOT NULL THEN RAISE EXCEPTION 'first result revision cannot supersede'; END IF;
  ELSE
    SELECT * INTO previous FROM strategy_lab_match_result_revisions WHERE id=NEW.supersedes;
    IF NOT FOUND OR previous.match_id<>NEW.match_id OR previous.match_date<>NEW.match_date OR previous.revision<>NEW.revision-1
       OR previous.source_updated_at>=NEW.source_updated_at THEN RAISE EXCEPTION 'invalid result revision chain'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION strategy_lab_reject_result_revision_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'match result revisions are append-only'; END $$;

CREATE FUNCTION strategy_lab_validate_trusted_settlement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prediction strategy_lab_predictions%ROWTYPE; snapshot_set strategy_lab_snapshot_sets%ROWTYPE;
  experiment_run strategy_lab_experiment_runs%ROWTYPE; previous_settlement strategy_lab_settlements%ROWTYPE;
  revision_row strategy_lab_match_result_revisions%ROWTYPE; quote odds_snapshots%ROWTYPE;
BEGIN
  IF NEW.match_result_revision_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.calculator_version IS NULL OR NEW.evidence_hash IS NULL THEN RAISE EXCEPTION 'trusted settlement calculator metadata required'; END IF;
  SELECT * INTO prediction FROM strategy_lab_predictions WHERE id=NEW.prediction_id;
  SELECT * INTO experiment_run FROM strategy_lab_experiment_runs WHERE id=prediction.run_id;
  SELECT * INTO snapshot_set FROM strategy_lab_snapshot_sets WHERE id=prediction.snapshot_set_id;
  SELECT * INTO revision_row FROM strategy_lab_match_result_revisions WHERE id=NEW.match_result_revision_id;
  IF prediction.decision_status<>'recommend' OR prediction.selection IS NULL OR prediction.evidence_contract_version<>2
     OR experiment_run.run_type<>'shadow' OR experiment_run.status NOT IN('running','succeeded') THEN RAISE EXCEPTION 'prediction is not settleable'; END IF;
  IF revision_row.match_id<>prediction.match_id OR revision_row.match_date<>prediction.match_date
     OR NEW.match_result_id<>revision_row.source_match_result_id THEN RAISE EXCEPTION 'settlement result revision identity mismatch'; END IF;
  IF revision_row.status='pending' THEN RAISE EXCEPTION 'pending result cannot be settled'; END IF;
  IF revision_row.status='special' AND (NEW.outcome<>'unavailable' OR NEW.is_counted OR NEW.profit_units IS NOT NULL) THEN RAISE EXCEPTION 'special result must be unavailable'; END IF;
  IF revision_row.status='finished' AND (NEW.outcome='unavailable' OR NOT NEW.is_counted OR NEW.profit_units IS NULL) THEN RAISE EXCEPTION 'finished result must be counted'; END IF;
   IF NEW.evidence->>'schemaVersion'<>'strategy-lab-settlement-evidence-v2' OR NEW.evidence->>'calculatorVersion'<>NEW.calculator_version
     OR NEW.evidence->>'scoreRevisionHash'<>revision_row.content_hash THEN RAISE EXCEPTION 'settlement evidence contract mismatch'; END IF;
  IF NEW.quote_basis='actual' THEN
    IF NEW.actual_quote_snapshot_id IS DISTINCT FROM prediction.executed_actual_quote_snapshot_id THEN RAISE EXCEPTION 'actual quote binding mismatch'; END IF;
    SELECT * INTO quote FROM odds_snapshots WHERE id=NEW.actual_quote_snapshot_id;
    IF quote.company_id<>'3' OR quote.market_type<>'asian_handicap' OR quote.hash_version<>'canonical-json-v2'
       OR quote.canonical_content_hash IS NULL OR quote.canonical_content_hash<>quote.content_hash
       OR quote.match_id<>prediction.match_id OR quote.match_date<>prediction.match_date
       OR quote.source_observed_at IS NULL OR quote.source_observed_at>quote.collected_at
       OR quote.source_observed_at>=COALESCE((SELECT kickoff_at FROM strategy_lab_match_facts WHERE match_id=prediction.match_id AND match_date=prediction.match_date ORDER BY revision DESC LIMIT 1),'infinity')
       OR quote.collected_at>=COALESCE((SELECT kickoff_at FROM strategy_lab_match_facts WHERE match_id=prediction.match_id AND match_date=prediction.match_date ORDER BY revision DESC LIMIT 1),'infinity')
       OR quote.source_observed_at>snapshot_set.checkpoint_at OR quote.collected_at>snapshot_set.checkpoint_at THEN RAISE EXCEPTION 'actual quote is not authoritative'; END IF;
  ELSE
    IF NEW.actual_quote_snapshot_id IS NOT NULL OR prediction.theoretical_handicap_raw IS NULL
       OR prediction.theoretical_handicap_quarter_units IS NULL OR prediction.theoretical_selected_water IS NULL
       OR NEW.quote_handicap_raw IS DISTINCT FROM prediction.theoretical_handicap_raw
       OR NEW.quote_handicap_quarter_units IS DISTINCT FROM prediction.theoretical_handicap_quarter_units
       OR NEW.quote_selected_water IS DISTINCT FROM prediction.theoretical_selected_water
       OR NEW.quote_selected_water_millionths IS DISTINCT FROM (prediction.theoretical_selected_water*1000000)::INTEGER
       THEN RAISE EXCEPTION 'theoretical quote is not authoritative'; END IF;
  END IF;
  IF NEW.revision>1 THEN
    SELECT * INTO previous_settlement FROM strategy_lab_settlements WHERE id=NEW.supersedes;
    IF previous_settlement.prediction_id IS DISTINCT FROM NEW.prediction_id
       OR previous_settlement.revision IS DISTINCT FROM NEW.revision-1
       OR previous_settlement.quote_basis IS DISTINCT FROM NEW.quote_basis
       OR previous_settlement.actual_quote_snapshot_id IS DISTINCT FROM NEW.actual_quote_snapshot_id
       OR previous_settlement.quote_handicap_raw IS DISTINCT FROM NEW.quote_handicap_raw
       OR previous_settlement.quote_handicap_quarter_units IS DISTINCT FROM NEW.quote_handicap_quarter_units
       OR previous_settlement.quote_selected_water IS DISTINCT FROM NEW.quote_selected_water
       OR previous_settlement.quote_selected_water_millionths IS DISTINCT FROM NEW.quote_selected_water_millionths
       THEN RAISE EXCEPTION 'settlement successor quote drift'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER strategy_lab_match_result_revisions_validate BEFORE INSERT ON strategy_lab_match_result_revisions FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_match_result_revision();
CREATE TRIGGER strategy_lab_match_result_revisions_append_only BEFORE UPDATE OR DELETE ON strategy_lab_match_result_revisions FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_result_revision_mutation();
CREATE TRIGGER strategy_lab_settlements_validate_trusted BEFORE INSERT ON strategy_lab_settlements FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_trusted_settlement();
CREATE INDEX strategy_lab_match_result_revisions_latest_idx ON strategy_lab_match_result_revisions(match_id,match_date,revision DESC);

ALTER TABLE strategy_lab_match_result_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_match_result_revisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON strategy_lab_match_result_revisions FROM PUBLIC;
REVOKE ALL ON FUNCTION strategy_lab_validate_match_result_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION strategy_lab_reject_result_revision_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION strategy_lab_validate_trusted_settlement() FROM PUBLIC;

INSERT INTO schema_migrations(version,description) VALUES('0023_strategy_lab_trusted_settlement','Immutable result revisions and trusted deterministic settlement evidence');
