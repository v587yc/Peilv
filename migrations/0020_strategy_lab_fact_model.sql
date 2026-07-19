BEGIN;

CREATE TABLE strategy_lab_snapshot_sets (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL,
  match_id VARCHAR(20) NOT NULL,
  match_date VARCHAR(8) NOT NULL,
  checkpoint_type TEXT NOT NULL,
  checkpoint_at TIMESTAMPTZ NOT NULL,
  dataset_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  previous_snapshot_set_id UUID REFERENCES strategy_lab_snapshot_sets(id),
  revision INTEGER NOT NULL,
  supersedes_snapshot_set_id UUID REFERENCES strategy_lab_snapshot_sets(id),
  source_cutoff_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  completeness JSONB NOT NULL,
  trace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_lab_snapshot_sets_match_date_check CHECK (
    match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
  ),
  CONSTRAINT strategy_lab_snapshot_sets_checkpoint_check CHECK (checkpoint_type IN ('T1215', 'T30', 'T03')),
  CONSTRAINT strategy_lab_snapshot_sets_dataset_mode_check CHECK (dataset_mode IN ('strict_asof', 'reconstructed')),
  CONSTRAINT strategy_lab_snapshot_sets_status_check CHECK (status IN ('ready', 'partial', 'insufficient', 'invalid', 'missing')),
  CONSTRAINT strategy_lab_snapshot_sets_completeness_check CHECK (
    status IN ('ready', 'partial')
    OR (jsonb_typeof(completeness) = 'object' AND btrim(COALESCE(completeness->>'reasonCode', '')) <> '')
  ),
  CONSTRAINT strategy_lab_snapshot_sets_schema_version_check CHECK (schema_version > 0),
  CONSTRAINT strategy_lab_snapshot_sets_revision_check CHECK (revision > 0),
  CONSTRAINT strategy_lab_snapshot_sets_hash_check CHECK (btrim(content_hash) <> ''),
  CONSTRAINT strategy_lab_snapshot_sets_trace_check CHECK (btrim(trace_id) <> ''),
  CONSTRAINT strategy_lab_snapshot_sets_cutoff_check CHECK (
    dataset_mode = 'reconstructed' OR source_cutoff_at <= checkpoint_at
  ),
  CONSTRAINT strategy_lab_snapshot_sets_not_self_previous_check CHECK (previous_snapshot_set_id IS NULL OR previous_snapshot_set_id <> id),
  CONSTRAINT strategy_lab_snapshot_sets_not_self_supersedes_check CHECK (supersedes_snapshot_set_id IS NULL OR supersedes_snapshot_set_id <> id),
  CONSTRAINT strategy_lab_snapshot_sets_revision_unique UNIQUE (
    run_id, match_id, match_date, checkpoint_type, checkpoint_at, dataset_mode, schema_version, revision
  ),
  CONSTRAINT strategy_lab_snapshot_sets_content_unique UNIQUE (
    run_id, match_id, match_date, checkpoint_type, checkpoint_at, dataset_mode, schema_version, content_hash
  )
);
CREATE UNIQUE INDEX strategy_lab_snapshot_sets_supersedes_unique
  ON strategy_lab_snapshot_sets(supersedes_snapshot_set_id) WHERE supersedes_snapshot_set_id IS NOT NULL;

CREATE TABLE strategy_lab_snapshot_items (
  snapshot_set_id UUID NOT NULL REFERENCES strategy_lab_snapshot_sets(id),
  odds_snapshot_id INTEGER NOT NULL REFERENCES odds_snapshots(id),
  role TEXT NOT NULL,
  company_id VARCHAR(20) NOT NULL,
  market_type TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  source_observed_at TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (snapshot_set_id, odds_snapshot_id, role),
  CONSTRAINT strategy_lab_snapshot_items_role_check CHECK (btrim(role) <> ''),
  CONSTRAINT strategy_lab_snapshot_items_company_check CHECK (btrim(company_id) <> ''),
  CONSTRAINT strategy_lab_snapshot_items_market_check CHECK (btrim(market_type) <> ''),
  CONSTRAINT strategy_lab_snapshot_items_snapshot_type_check CHECK (btrim(snapshot_type) <> '')
);

CREATE TABLE strategy_lab_experiment_runs (
  id UUID PRIMARY KEY,
  run_type TEXT NOT NULL,
  status TEXT NOT NULL,
  dataset_mode TEXT NOT NULL,
  start_date VARCHAR(8) NOT NULL,
  end_date VARCHAR(8) NOT NULL,
  dataset_cutoff_at TIMESTAMPTZ NOT NULL,
  strategy_versions JSONB NOT NULL,
  configuration JSONB NOT NULL,
  code_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  error_summary TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_lab_experiment_runs_type_check CHECK (run_type IN ('shadow', 'backtest', 'manual')),
  CONSTRAINT strategy_lab_experiment_runs_status_check CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT strategy_lab_experiment_runs_dataset_mode_check CHECK (dataset_mode IN ('strict_asof', 'reconstructed')),
  CONSTRAINT strategy_lab_experiment_runs_start_date_check CHECK (
    start_date ~ '^[0-9]{8}$' AND to_char(to_date(start_date, 'YYYYMMDD'), 'YYYYMMDD') = start_date
  ),
  CONSTRAINT strategy_lab_experiment_runs_end_date_check CHECK (
    end_date ~ '^[0-9]{8}$' AND to_char(to_date(end_date, 'YYYYMMDD'), 'YYYYMMDD') = end_date
  ),
  CONSTRAINT strategy_lab_experiment_runs_range_check CHECK (start_date <= end_date),
  CONSTRAINT strategy_lab_experiment_runs_identity_check CHECK (
    btrim(code_version) <> '' AND btrim(idempotency_key) <> '' AND btrim(created_by) <> '' AND btrim(trace_id) <> ''
  ),
  CONSTRAINT strategy_lab_experiment_runs_time_check CHECK (
    updated_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (finished_at IS NULL OR finished_at >= created_at)
    AND (
      (status = 'pending' AND started_at IS NULL AND finished_at IS NULL)
      OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND updated_at >= started_at)
      OR (status IN ('succeeded', 'failed') AND started_at IS NOT NULL AND finished_at IS NOT NULL
        AND finished_at >= started_at AND updated_at >= finished_at)
      OR (status = 'cancelled' AND finished_at IS NOT NULL
        AND (started_at IS NULL OR finished_at >= started_at) AND updated_at >= finished_at)
    )
  )
);

ALTER TABLE strategy_lab_snapshot_sets
  ADD CONSTRAINT strategy_lab_snapshot_sets_run_fk
  FOREIGN KEY (run_id) REFERENCES strategy_lab_experiment_runs(id);

CREATE TABLE strategy_lab_predictions (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES strategy_lab_experiment_runs(id),
  match_id VARCHAR(20) NOT NULL,
  match_date VARCHAR(8) NOT NULL,
  checkpoint_type TEXT NOT NULL,
  snapshot_set_id UUID NOT NULL REFERENCES strategy_lab_snapshot_sets(id),
  requested_strategy TEXT NOT NULL,
  executed_strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL REFERENCES strategy_versions(version),
  decision_status TEXT NOT NULL,
  selection TEXT,
  locked_deterministic BOOLEAN NOT NULL,
  reason_code TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  decision_payload JSONB NOT NULL,
  fallback_reason TEXT,
  legacy_prediction_id INTEGER REFERENCES prediction_results(id),
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  trace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_lab_predictions_match_date_check CHECK (
    match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
  ),
  CONSTRAINT strategy_lab_predictions_checkpoint_check CHECK (checkpoint_type IN ('T1215', 'T30', 'T03')),
  CONSTRAINT strategy_lab_predictions_requested_check CHECK (requested_strategy IN ('A', 'B', 'C', 'D')),
  CONSTRAINT strategy_lab_predictions_executed_check CHECK (executed_strategy IN ('A', 'B', 'C', 'D')),
  CONSTRAINT strategy_lab_predictions_identity_check CHECK (
    (requested_strategy = 'C' AND executed_strategy IN ('C', 'A'))
    OR (requested_strategy <> 'C' AND executed_strategy = requested_strategy)
  ),
  CONSTRAINT strategy_lab_predictions_fallback_check CHECK (
    (requested_strategy = 'C' AND executed_strategy = 'A' AND fallback_reason IS NOT NULL AND btrim(fallback_reason) <> '')
    OR (NOT (requested_strategy = 'C' AND executed_strategy = 'A') AND fallback_reason IS NULL)
  ),
  CONSTRAINT strategy_lab_predictions_status_check CHECK (
    decision_status IN ('recommend', 'observe', 'reanalyze_required', 'insufficient_data')
  ),
  CONSTRAINT strategy_lab_predictions_selection_check CHECK (
    (decision_status = 'recommend' AND selection IS NOT NULL AND selection IN ('home', 'away'))
    OR (decision_status <> 'recommend' AND selection IS NULL)
  ),
  CONSTRAINT strategy_lab_predictions_source_check CHECK (source IN ('experiment', 'd_compat_shadow')),
  CONSTRAINT strategy_lab_predictions_required_text_check CHECK (
    btrim(strategy_version) <> '' AND btrim(reason_code) <> '' AND btrim(branch_id) <> ''
    AND btrim(input_hash) <> '' AND btrim(output_hash) <> '' AND btrim(idempotency_key) <> '' AND btrim(trace_id) <> ''
  ),
  CONSTRAINT strategy_lab_predictions_matrix_unique UNIQUE (
    run_id, match_id, match_date, checkpoint_type, requested_strategy
  )
);

CREATE TABLE strategy_lab_settlements (
  id UUID PRIMARY KEY,
  prediction_id UUID NOT NULL REFERENCES strategy_lab_predictions(id),
  revision INTEGER NOT NULL,
  match_result_id INTEGER NOT NULL REFERENCES match_results(id),
  actual_quote_snapshot_id INTEGER REFERENCES odds_snapshots(id),
  quote_basis TEXT NOT NULL,
  outcome TEXT NOT NULL,
  profit_units NUMERIC(12, 6),
  is_counted BOOLEAN NOT NULL,
  settlement_basis TEXT NOT NULL,
  evidence JSONB NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL,
  settled_by TEXT NOT NULL,
  supersedes UUID REFERENCES strategy_lab_settlements(id),
  trace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_lab_settlements_revision_check CHECK (revision > 0),
  CONSTRAINT strategy_lab_settlements_quote_basis_check CHECK (quote_basis IN ('actual', 'theoretical')),
  CONSTRAINT strategy_lab_settlements_outcome_check CHECK (
    outcome IN ('win', 'half_win', 'push', 'half_loss', 'loss', 'unavailable')
  ),
  CONSTRAINT strategy_lab_settlements_basis_pair_check CHECK (
    (quote_basis = 'actual' AND settlement_basis = 'actual_quote'
      AND actual_quote_snapshot_id IS NOT NULL
      AND jsonb_typeof(evidence) = 'object'
      AND NOT (evidence ? 'actualQuoteSnapshotId')
      AND NOT (evidence ? 'theoreticalQuote'))
    OR (quote_basis = 'theoretical' AND settlement_basis = 'theoretical_quote'
      AND actual_quote_snapshot_id IS NULL
      AND jsonb_typeof(evidence) = 'object'
      AND evidence ? 'theoreticalQuote'
      AND jsonb_typeof(evidence->'theoreticalQuote') = 'object'
      AND evidence->'theoreticalQuote' <> '{}'::jsonb
      AND NOT (evidence ? 'actualQuoteSnapshotId'))
  ),
  CONSTRAINT strategy_lab_settlements_profit_check CHECK (
    (outcome = 'unavailable' AND profit_units IS NULL AND is_counted = FALSE)
    OR (outcome IN ('win', 'half_win') AND profit_units IS NOT NULL AND profit_units > 0 AND is_counted = TRUE)
    OR (outcome = 'push' AND profit_units IS NOT NULL AND profit_units = 0 AND is_counted = TRUE)
    OR (outcome IN ('half_loss', 'loss') AND profit_units IS NOT NULL AND profit_units < 0 AND is_counted = TRUE)
  ),
  CONSTRAINT strategy_lab_settlements_identity_check CHECK (btrim(settled_by) <> '' AND btrim(trace_id) <> ''),
  CONSTRAINT strategy_lab_settlements_not_self_supersedes_check CHECK (supersedes IS NULL OR supersedes <> id),
  CONSTRAINT strategy_lab_settlements_revision_unique UNIQUE (prediction_id, revision)
);
CREATE UNIQUE INDEX strategy_lab_settlements_supersedes_unique
  ON strategy_lab_settlements(supersedes) WHERE supersedes IS NOT NULL;

CREATE TABLE strategy_lab_command_receipts (
  id UUID PRIMARY KEY,
  action TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'audit_pending',
  result_type TEXT NOT NULL,
  result_id UUID NOT NULL,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  audit_attempts INTEGER NOT NULL DEFAULT 0,
  last_audit_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  audited_at TIMESTAMPTZ,
  CONSTRAINT strategy_lab_command_receipts_action_check CHECK (
    action IN ('run.create', 'run.transition', 'snapshot.capture', 'prediction.execute', 'settlement.create')
  ),
  CONSTRAINT strategy_lab_command_receipts_status_check CHECK (status IN ('audit_pending', 'audited')),
  CONSTRAINT strategy_lab_command_receipts_result_type_check CHECK (
    result_type IN ('strategy_lab_run', 'strategy_lab_snapshot', 'strategy_lab_prediction', 'strategy_lab_settlement')
  ),
  CONSTRAINT strategy_lab_command_receipts_required_text_check CHECK (
    btrim(operation_key) <> '' AND btrim(payload_hash) <> '' AND btrim(result_type) <> ''
    AND btrim(actor_id) <> '' AND btrim(request_id) <> ''
  ),
  CONSTRAINT strategy_lab_command_receipts_audit_check CHECK (
    audit_attempts >= 0
    AND ((status = 'audit_pending' AND audited_at IS NULL) OR (status = 'audited' AND audited_at IS NOT NULL))
  ),
  CONSTRAINT strategy_lab_command_receipts_action_key_unique UNIQUE (action, operation_key)
);

CREATE FUNCTION strategy_lab_reject_fact_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'strategy lab fact tables are append-only';
END;
$$;

CREATE FUNCTION strategy_lab_validate_snapshot_item_asof()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  snapshot_set strategy_lab_snapshot_sets%ROWTYPE;
  source_snapshot odds_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO snapshot_set FROM strategy_lab_snapshot_sets WHERE id = NEW.snapshot_set_id;
  SELECT * INTO source_snapshot FROM odds_snapshots WHERE id = NEW.odds_snapshot_id;
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
  ) THEN
    RAISE EXCEPTION 'strict_asof evidence exceeds checkpoint';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION strategy_lab_validate_snapshot_item_completeness()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('ready', 'partial')
     AND NOT EXISTS (SELECT 1 FROM strategy_lab_snapshot_items WHERE snapshot_set_id = NEW.id) THEN
    RAISE EXCEPTION 'ready or partial snapshot requires evidence items';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION strategy_lab_validate_snapshot_set_insert()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous_set strategy_lab_snapshot_sets%ROWTYPE; superseded_set strategy_lab_snapshot_sets%ROWTYPE;
BEGIN
  IF NEW.checkpoint_type = 'T1215' THEN
    IF NEW.previous_snapshot_set_id IS NOT NULL THEN RAISE EXCEPTION 'T1215 cannot have previous checkpoint'; END IF;
  ELSE
    IF NEW.previous_snapshot_set_id IS NULL THEN RAISE EXCEPTION 'checkpoint predecessor is required'; END IF;
    SELECT * INTO previous_set FROM strategy_lab_snapshot_sets WHERE id = NEW.previous_snapshot_set_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'checkpoint predecessor is unavailable'; END IF;
    IF previous_set.run_id <> NEW.run_id OR previous_set.match_id <> NEW.match_id OR previous_set.match_date <> NEW.match_date
       OR previous_set.dataset_mode <> NEW.dataset_mode OR previous_set.checkpoint_at >= NEW.checkpoint_at THEN
      RAISE EXCEPTION 'invalid checkpoint predecessor identity or ordering';
    END IF;
    IF (NEW.checkpoint_type = 'T30' AND previous_set.checkpoint_type <> 'T1215')
       OR (NEW.checkpoint_type = 'T03' AND previous_set.checkpoint_type <> 'T30') THEN
      RAISE EXCEPTION 'invalid checkpoint predecessor type';
    END IF;
  END IF;
  IF NEW.revision = 1 THEN
    IF NEW.supersedes_snapshot_set_id IS NOT NULL THEN RAISE EXCEPTION 'first snapshot revision cannot supersede'; END IF;
  ELSE
    IF NEW.supersedes_snapshot_set_id IS NULL THEN RAISE EXCEPTION 'snapshot revision predecessor is required'; END IF;
    SELECT * INTO superseded_set FROM strategy_lab_snapshot_sets WHERE id = NEW.supersedes_snapshot_set_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'snapshot revision predecessor is unavailable'; END IF;
    IF superseded_set.run_id <> NEW.run_id OR superseded_set.match_id <> NEW.match_id OR superseded_set.match_date <> NEW.match_date
       OR superseded_set.checkpoint_type <> NEW.checkpoint_type OR superseded_set.checkpoint_at <> NEW.checkpoint_at
       OR superseded_set.dataset_mode <> NEW.dataset_mode OR superseded_set.schema_version <> NEW.schema_version
       OR superseded_set.revision <> NEW.revision - 1 THEN
      RAISE EXCEPTION 'invalid snapshot revision chain';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION strategy_lab_validate_prediction_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE snapshot_set strategy_lab_snapshot_sets%ROWTYPE;
BEGIN
  SELECT * INTO snapshot_set FROM strategy_lab_snapshot_sets WHERE id = NEW.snapshot_set_id;
  IF NOT FOUND OR snapshot_set.run_id <> NEW.run_id
     OR snapshot_set.match_id <> NEW.match_id OR snapshot_set.match_date <> NEW.match_date
     OR snapshot_set.checkpoint_type <> NEW.checkpoint_type THEN
    RAISE EXCEPTION 'prediction snapshot identity mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION strategy_lab_validate_receipt_transition()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.result_type IS DISTINCT FROM OLD.result_type OR NEW.result_id IS DISTINCT FROM OLD.result_id
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'command receipt immutable fields cannot change';
  END IF;
  IF OLD.status <> 'audit_pending' OR NEW.audit_attempts <> OLD.audit_attempts + 1
     OR NEW.updated_at < OLD.updated_at
     OR (NEW.status = 'audit_pending' AND (NEW.audited_at IS NOT NULL OR btrim(COALESCE(NEW.last_audit_error_code, '')) = ''))
     OR (NEW.status = 'audited' AND (NEW.audited_at IS NULL OR NEW.last_audit_error_code IS NOT NULL))
     OR NEW.status NOT IN ('audit_pending', 'audited') THEN
    RAISE EXCEPTION 'invalid command receipt transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION strategy_lab_validate_settlement_revision()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE superseded_settlement strategy_lab_settlements%ROWTYPE;
BEGIN
  IF NEW.revision = 1 THEN
    IF NEW.supersedes IS NOT NULL THEN RAISE EXCEPTION 'first settlement revision cannot supersede'; END IF;
  ELSE
    IF NEW.supersedes IS NULL THEN RAISE EXCEPTION 'settlement revision predecessor is required'; END IF;
    SELECT * INTO superseded_settlement FROM strategy_lab_settlements WHERE id = NEW.supersedes;
    IF NOT FOUND OR superseded_settlement.prediction_id <> NEW.prediction_id
       OR superseded_settlement.revision <> NEW.revision - 1 THEN
      RAISE EXCEPTION 'invalid settlement revision chain';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION strategy_lab_validate_settlement_evidence()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE prediction strategy_lab_predictions%ROWTYPE; result match_results%ROWTYPE; actual_quote odds_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO prediction FROM strategy_lab_predictions WHERE id = NEW.prediction_id;
  SELECT * INTO result FROM match_results WHERE id = NEW.match_result_id;
  IF prediction.match_id <> result.match_id OR prediction.match_date <> result.match_date THEN
    RAISE EXCEPTION 'settlement match result identity mismatch';
  END IF;
  IF NEW.quote_basis = 'actual' THEN
    SELECT * INTO actual_quote FROM odds_snapshots WHERE id = NEW.actual_quote_snapshot_id;
    IF actual_quote.match_id <> prediction.match_id OR actual_quote.match_date <> prediction.match_date THEN
      RAISE EXCEPTION 'actual quote snapshot identity mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION strategy_lab_validate_run_transition()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_type IS DISTINCT FROM OLD.run_type
     OR NEW.dataset_mode IS DISTINCT FROM OLD.dataset_mode OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.end_date IS DISTINCT FROM OLD.end_date OR NEW.dataset_cutoff_at IS DISTINCT FROM OLD.dataset_cutoff_at
     OR NEW.strategy_versions IS DISTINCT FROM OLD.strategy_versions OR NEW.configuration IS DISTINCT FROM OLD.configuration
     OR NEW.code_version IS DISTINCT FROM OLD.code_version OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.trace_id IS DISTINCT FROM OLD.trace_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'experiment run immutable fields cannot change';
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('running', 'cancelled'))
       OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'cancelled'))) THEN
    RAISE EXCEPTION 'invalid experiment run transition';
  END IF;
  IF OLD.status = 'running' AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'experiment run started_at is immutable after start';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'experiment run updated_at cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION strategy_lab_validate_run_insert()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
     OR NEW.updated_at < NEW.created_at THEN
    RAISE EXCEPTION 'experiment run must start pending';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER strategy_lab_snapshot_sets_append_only
  BEFORE UPDATE OR DELETE ON strategy_lab_snapshot_sets
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation();
CREATE TRIGGER strategy_lab_snapshot_items_append_only
  BEFORE UPDATE OR DELETE ON strategy_lab_snapshot_items
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation();
CREATE TRIGGER strategy_lab_predictions_append_only
  BEFORE UPDATE OR DELETE ON strategy_lab_predictions
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation();
CREATE TRIGGER strategy_lab_settlements_append_only
  BEFORE UPDATE OR DELETE ON strategy_lab_settlements
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation();
CREATE TRIGGER strategy_lab_snapshot_items_asof
  BEFORE INSERT ON strategy_lab_snapshot_items
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_snapshot_item_asof();
CREATE CONSTRAINT TRIGGER strategy_lab_snapshot_sets_require_items
  AFTER INSERT ON strategy_lab_snapshot_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_snapshot_item_completeness();
CREATE TRIGGER strategy_lab_snapshot_sets_validate_insert
  BEFORE INSERT ON strategy_lab_snapshot_sets
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_snapshot_set_insert();
CREATE TRIGGER strategy_lab_predictions_validate_snapshot
  BEFORE INSERT ON strategy_lab_predictions
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_prediction_snapshot();
CREATE TRIGGER strategy_lab_settlements_validate_revision
  BEFORE INSERT ON strategy_lab_settlements
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_settlement_revision();
CREATE TRIGGER strategy_lab_settlements_validate_evidence
  BEFORE INSERT ON strategy_lab_settlements
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_settlement_evidence();
CREATE TRIGGER strategy_lab_experiment_runs_validate_transition
  BEFORE UPDATE ON strategy_lab_experiment_runs
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_run_transition();
CREATE TRIGGER strategy_lab_experiment_runs_validate_insert
  BEFORE INSERT ON strategy_lab_experiment_runs
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_run_insert();
CREATE TRIGGER strategy_lab_command_receipts_validate_transition
  BEFORE UPDATE ON strategy_lab_command_receipts
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_receipt_transition();

CREATE INDEX strategy_lab_snapshot_sets_match_checkpoint_idx
  ON strategy_lab_snapshot_sets(run_id, match_id, match_date, checkpoint_type, checkpoint_at);
CREATE INDEX strategy_lab_snapshot_items_set_market_idx
  ON strategy_lab_snapshot_items(snapshot_set_id, market_type, role);
CREATE INDEX strategy_lab_experiment_runs_status_idx
  ON strategy_lab_experiment_runs(status, created_at);
CREATE INDEX strategy_lab_experiment_runs_date_idx
  ON strategy_lab_experiment_runs(start_date, end_date, dataset_mode);
CREATE INDEX strategy_lab_predictions_run_matrix_idx
  ON strategy_lab_predictions(run_id, checkpoint_type, requested_strategy, decision_status);
CREATE INDEX strategy_lab_predictions_match_idx
  ON strategy_lab_predictions(match_id, match_date, checkpoint_type);
CREATE INDEX strategy_lab_settlements_prediction_idx
  ON strategy_lab_settlements(prediction_id, revision DESC);
CREATE INDEX strategy_lab_settlements_result_idx
  ON strategy_lab_settlements(match_result_id, quote_basis, is_counted);
CREATE INDEX strategy_lab_settlements_actual_quote_idx
  ON strategy_lab_settlements(actual_quote_snapshot_id) WHERE actual_quote_snapshot_id IS NOT NULL;
CREATE INDEX strategy_lab_command_receipts_pending_idx
  ON strategy_lab_command_receipts(status, created_at) WHERE status = 'audit_pending';

ALTER TABLE strategy_lab_snapshot_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_snapshot_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_experiment_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_command_receipts ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version, description)
VALUES ('0020_strategy_lab_fact_model', 'Add immutable strategy laboratory experiment facts and settlement revisions')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
