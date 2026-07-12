-- Canonical PostgreSQL/Supabase bootstrap. Safe to run repeatedly on an empty or existing database.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) PRIMARY KEY,
  description TEXT NOT NULL,
  checksum TEXT,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS health_check (
  id SERIAL PRIMARY KEY,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prediction_data (
  id SERIAL PRIMARY KEY,
  date_key VARCHAR(8) NOT NULL,
  json_content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prediction_data_date_key_check CHECK (
    date_key ~ '^[0-9]{8}$' AND to_char(to_date(date_key, 'YYYYMMDD'), 'YYYYMMDD') = date_key
  )
);
CREATE INDEX IF NOT EXISTS prediction_data_date_key_idx ON prediction_data(date_key);
CREATE UNIQUE INDEX IF NOT EXISTS prediction_data_date_key_unique ON prediction_data(date_key);

CREATE TABLE IF NOT EXISTS match_odds (
  id SERIAL PRIMARY KEY,
  match_id VARCHAR(20) NOT NULL,
  match_date VARCHAR(8) NOT NULL,
  company_ids TEXT NOT NULL DEFAULT '3,35,42,47',
  odds_data TEXT NOT NULL,
  open_times_data TEXT DEFAULT '{}',
  crown_live_odds TEXT,
  crown_12_odds TEXT,
  source TEXT,
  source_observed_at TIMESTAMPTZ,
  write_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT match_odds_match_date_check CHECK (
    match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
  )
);
CREATE INDEX IF NOT EXISTS match_odds_match_date_idx ON match_odds(match_date);
CREATE INDEX IF NOT EXISTS match_odds_match_id_idx ON match_odds(match_id);
CREATE UNIQUE INDEX IF NOT EXISTS match_odds_match_date_id_unique ON match_odds(match_id, match_date);
ALTER TABLE match_odds ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE match_odds ADD COLUMN IF NOT EXISTS source_observed_at TIMESTAMPTZ;
ALTER TABLE match_odds ADD COLUMN IF NOT EXISTS write_token TEXT;

CREATE OR REPLACE FUNCTION upsert_match_odds_if_fresher(
  p_match_id TEXT,
  p_match_date TEXT,
  p_company_ids TEXT,
  p_odds_data JSONB,
  p_open_times_data JSONB,
  p_crown_live_odds JSONB,
  p_crown_12_odds JSONB,
  p_source TEXT,
  p_source_observed_at TIMESTAMPTZ,
  p_write_token TEXT
) RETURNS TABLE(applied BOOLEAN, source_observed_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  written_observed_at TIMESTAMPTZ;
BEGIN
  IF NULLIF(btrim(p_source), '') IS NULL
     OR p_source_observed_at IS NULL
     OR NULLIF(btrim(p_write_token), '') IS NULL THEN
    RAISE EXCEPTION 'source, source_observed_at and write_token are required';
  END IF;

  INSERT INTO match_odds (
    match_id, match_date, company_ids, odds_data, open_times_data,
    crown_live_odds, crown_12_odds, source, source_observed_at, write_token, updated_at
  ) VALUES (
    p_match_id, p_match_date, p_company_ids, p_odds_data::TEXT, p_open_times_data::TEXT,
    p_crown_live_odds::TEXT, p_crown_12_odds::TEXT, p_source, p_source_observed_at, p_write_token, NOW()
  )
  ON CONFLICT (match_id, match_date) DO UPDATE SET
    company_ids = EXCLUDED.company_ids,
    odds_data = EXCLUDED.odds_data,
    open_times_data = COALESCE(EXCLUDED.open_times_data, match_odds.open_times_data),
    crown_live_odds = COALESCE(EXCLUDED.crown_live_odds, match_odds.crown_live_odds),
    crown_12_odds = COALESCE(EXCLUDED.crown_12_odds, match_odds.crown_12_odds),
    source = EXCLUDED.source,
    source_observed_at = EXCLUDED.source_observed_at,
    write_token = EXCLUDED.write_token,
    updated_at = NOW()
  WHERE (match_odds.source_observed_at IS NULL OR EXCLUDED.source_observed_at > match_odds.source_observed_at)
    AND match_odds.write_token IS DISTINCT FROM EXCLUDED.write_token
  RETURNING match_odds.source_observed_at INTO written_observed_at;

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, written_observed_at;
  ELSE
    RETURN QUERY
      SELECT current_row.write_token = p_write_token, current_row.source_observed_at
      FROM match_odds AS current_row
      WHERE current_row.match_id = p_match_id AND current_row.match_date = p_match_date;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS daily_reports (
  id SERIAL PRIMARY KEY,
  report_date VARCHAR(8) NOT NULL,
  report_content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT daily_reports_report_date_check CHECK (
    report_date ~ '^[0-9]{8}$' AND to_char(to_date(report_date, 'YYYYMMDD'), 'YYYYMMDD') = report_date
  )
);
CREATE INDEX IF NOT EXISTS daily_reports_report_date_idx ON daily_reports(report_date);
CREATE UNIQUE INDEX IF NOT EXISTS daily_reports_report_date_unique ON daily_reports(report_date);

CREATE TABLE IF NOT EXISTS prediction_results (
  id SERIAL PRIMARY KEY,
  match_id VARCHAR(20) NOT NULL,
  match_date VARCHAR(8) NOT NULL,
  source TEXT NOT NULL DEFAULT 'production',
  run_id TEXT,
  home_team TEXT,
  away_team TEXT,
  league TEXT,
  match_time TEXT,
  water_direction TEXT,
  handicap_trend TEXT,
  prediction TEXT,
  total_trend TEXT,
  total_prediction TEXT,
  confidence_level TEXT,
  accuracy TEXT,
  strategy TEXT,
  action TEXT,
  total_action TEXT,
  indicator_handicap_direction TEXT,
  indicator_water_direction TEXT,
  indicator_divergence TEXT,
  indicator_euro_asian TEXT,
  indicator_open_time TEXT,
  indicator_total_goals TEXT,
  up_score REAL,
  down_score REAL,
  crown_handicap TEXT,
  yinghe_handicap TEXT,
  who_open_later TEXT,
  indicators_json JSONB,
  news_summary TEXT,
  llm_reasoning TEXT,
  priority_rules_json JSONB,
  strategy_version TEXT,
  weights_version TEXT,
  model_version TEXT,
  weights_snapshot JSONB,
  is_correct BOOLEAN,
  manual_is_correct BOOLEAN,
  effective_is_correct BOOLEAN,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  water_verification_status TEXT NOT NULL DEFAULT 'pending',
  total_verification_status TEXT NOT NULL DEFAULT 'pending',
  effective_verification_status TEXT NOT NULL DEFAULT 'unverified',
  auto_is_correct BOOLEAN,
  actual_handicap_trend TEXT,
  actual_water_direction TEXT,
  auto_verified_at TIMESTAMPTZ,
  manually_verified_at TIMESTAMPTZ,
  manually_verified_by TEXT,
  verified_at TIMESTAMPTZ,
  analyzed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prediction_results_match_date_check CHECK (
    match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
  )
);
CREATE INDEX IF NOT EXISTS prediction_results_match_date_idx ON prediction_results(match_date);
CREATE INDEX IF NOT EXISTS prediction_results_match_id_idx ON prediction_results(match_id);
CREATE INDEX IF NOT EXISTS prediction_results_versions_idx ON prediction_results(strategy_version, weights_version, model_version);
CREATE UNIQUE INDEX IF NOT EXISTS prediction_results_match_date_unique ON prediction_results(match_id, match_date);

CREATE TABLE IF NOT EXISTS prediction_results_backtest (
  LIKE prediction_results INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS
);
CREATE SEQUENCE IF NOT EXISTS prediction_results_backtest_id_seq;
ALTER SEQUENCE prediction_results_backtest_id_seq OWNED BY prediction_results_backtest.id;
ALTER TABLE prediction_results_backtest ALTER COLUMN id SET DEFAULT nextval('prediction_results_backtest_id_seq');
SELECT setval(
  'prediction_results_backtest_id_seq',
  GREATEST(COALESCE(MAX(id), 0) + 1, 1),
  false
) FROM prediction_results_backtest;
UPDATE prediction_results_backtest SET id = nextval('prediction_results_backtest_id_seq') WHERE id IS NULL;
ALTER TABLE prediction_results_backtest ALTER COLUMN id SET NOT NULL;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS run_id TEXT;
CREATE INDEX IF NOT EXISTS prediction_results_backtest_date_idx ON prediction_results_backtest(match_date);
CREATE UNIQUE INDEX IF NOT EXISTS prediction_results_backtest_run_match_unique
  ON prediction_results_backtest(run_id, match_id, match_date);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'prediction_results_backtest'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE prediction_results_backtest ADD CONSTRAINT prediction_results_backtest_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS learned_patterns (
  id SERIAL PRIMARY KEY,
  pattern_key TEXT NOT NULL,
  pattern_description TEXT,
  league TEXT NOT NULL DEFAULT 'ALL',
  total_predictions REAL NOT NULL DEFAULT 0,
  correct_predictions REAL NOT NULL DEFAULT 0,
  hit_rate REAL NOT NULL DEFAULT 0,
  indicator_signals JSONB,
  suggested_weights JSONB,
  strategy_version TEXT,
  weights_version TEXT,
  model_version TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  training_window_start VARCHAR(8),
  training_window_end VARCHAR(8),
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT learned_patterns_training_start_check CHECK (
    training_window_start IS NULL OR (
      training_window_start ~ '^[0-9]{8}$'
      AND to_char(to_date(training_window_start, 'YYYYMMDD'), 'YYYYMMDD') = training_window_start
    )
  ),
  CONSTRAINT learned_patterns_training_end_check CHECK (
    training_window_end IS NULL OR (
      training_window_end ~ '^[0-9]{8}$'
      AND to_char(to_date(training_window_end, 'YYYYMMDD'), 'YYYYMMDD') = training_window_end
    )
  )
);
CREATE INDEX IF NOT EXISTS learned_patterns_league_idx ON learned_patterns(league);
CREATE INDEX IF NOT EXISTS learned_patterns_status_idx ON learned_patterns(status, published_at);
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_key_unique ON learned_patterns(pattern_key, league);

CREATE TABLE IF NOT EXISTS learned_patterns_backtest (
  LIKE learned_patterns INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS
);
CREATE SEQUENCE IF NOT EXISTS learned_patterns_backtest_id_seq;
ALTER SEQUENCE learned_patterns_backtest_id_seq OWNED BY learned_patterns_backtest.id;
ALTER TABLE learned_patterns_backtest ALTER COLUMN id SET DEFAULT nextval('learned_patterns_backtest_id_seq');
SELECT setval(
  'learned_patterns_backtest_id_seq',
  GREATEST(COALESCE(MAX(id), 0) + 1, 1),
  false
) FROM learned_patterns_backtest;
UPDATE learned_patterns_backtest SET id = nextval('learned_patterns_backtest_id_seq') WHERE id IS NULL;
ALTER TABLE learned_patterns_backtest ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_backtest_key_unique
  ON learned_patterns_backtest(pattern_key, league);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'learned_patterns_backtest'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE learned_patterns_backtest ADD CONSTRAINT learned_patterns_backtest_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prediction_results_backtest_match_date_check') THEN
    ALTER TABLE prediction_results_backtest ADD CONSTRAINT prediction_results_backtest_match_date_check CHECK (
      match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learned_patterns_backtest_training_start_check') THEN
    ALTER TABLE learned_patterns_backtest ADD CONSTRAINT learned_patterns_backtest_training_start_check CHECK (
      training_window_start IS NULL OR (
        training_window_start ~ '^[0-9]{8}$'
        AND to_char(to_date(training_window_start, 'YYYYMMDD'), 'YYYYMMDD') = training_window_start
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learned_patterns_backtest_training_end_check') THEN
    ALTER TABLE learned_patterns_backtest ADD CONSTRAINT learned_patterns_backtest_training_end_check CHECK (
      training_window_end IS NULL OR (
        training_window_end ~ '^[0-9]{8}$'
        AND to_char(to_date(training_window_end, 'YYYYMMDD'), 'YYYYMMDD') = training_window_end
      )
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS strategy_versions (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  rules JSONB NOT NULL DEFAULT '{}'::JSONB,
  weights JSONB NOT NULL DEFAULT '{}'::JSONB,
  model_version TEXT NOT NULL,
  model_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  parent_version TEXT,
  effective_from TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS strategy_versions_status_idx ON strategy_versions(status, effective_from);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memory_bank (
  id SERIAL PRIMARY KEY,
  conversation_id TEXT,
  memory_type TEXT DEFAULT 'short',
  content TEXT,
  score REAL DEFAULT 0,
  keywords TEXT,
  original_id TEXT,
  summary TEXT,
  compressed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS memory_bank_conversation_idx ON memory_bank(conversation_id);

CREATE TABLE IF NOT EXISTS league_selections (
  id SERIAL PRIMARY KEY,
  date_key VARCHAR(8) NOT NULL,
  mode VARCHAR(20) NOT NULL DEFAULT 'today',
  league_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT league_selections_date_key_check CHECK (
    date_key ~ '^[0-9]{8}$' AND to_char(to_date(date_key, 'YYYYMMDD'), 'YYYYMMDD') = date_key
  )
);
CREATE INDEX IF NOT EXISTS league_selections_date_mode_idx ON league_selections(date_key, mode);
CREATE UNIQUE INDEX IF NOT EXISTS league_selections_date_mode_league_unique
  ON league_selections(date_key, mode, league_name);

CREATE TABLE IF NOT EXISTS user_focused_leagues (
  id SERIAL PRIMARY KEY,
  league_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_focused_leagues_name_unique ON user_focused_leagues(league_name);

CREATE TABLE IF NOT EXISTS backtest_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  current_step TEXT,
  start_date VARCHAR(8) NOT NULL,
  end_date VARCHAR(8) NOT NULL,
  "current_date" VARCHAR(8) NOT NULL,
  total_dates INTEGER NOT NULL DEFAULT 0,
  processed_dates INTEGER NOT NULL DEFAULT 0,
  total_matches INTEGER NOT NULL DEFAULT 0,
  analyzed_matches INTEGER NOT NULL DEFAULT 0,
  verified_matches INTEGER NOT NULL DEFAULT 0,
  correct_matches INTEGER NOT NULL DEFAULT 0,
  accuracy TEXT NOT NULL DEFAULT '0%',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lock_owner TEXT,
  lock_expires_at TIMESTAMPTZ,
  log JSONB NOT NULL DEFAULT '[]'::JSONB,
  result JSONB,
  last_error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT backtest_jobs_start_date_check CHECK (
    start_date ~ '^[0-9]{8}$' AND to_char(to_date(start_date, 'YYYYMMDD'), 'YYYYMMDD') = start_date
  ),
  CONSTRAINT backtest_jobs_end_date_check CHECK (
    end_date ~ '^[0-9]{8}$' AND to_char(to_date(end_date, 'YYYYMMDD'), 'YYYYMMDD') = end_date
  ),
  CONSTRAINT backtest_jobs_current_date_check CHECK (
    "current_date" ~ '^[0-9]{8}$' AND to_char(to_date("current_date", 'YYYYMMDD'), 'YYYYMMDD') = "current_date"
  )
);
CREATE INDEX IF NOT EXISTS backtest_jobs_status_idx ON backtest_jobs(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS backtest_jobs_idempotency_unique
  ON backtest_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS automation_tasks (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  date_key VARCHAR(8) NOT NULL,
  match_id VARCHAR(20),
  source TEXT NOT NULL DEFAULT 'production',
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  current_step TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lock_owner TEXT,
  lock_expires_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  result JSONB,
  last_error TEXT,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_tasks_date_key_check CHECK (
    date_key ~ '^[0-9]{8}$' AND to_char(to_date(date_key, 'YYYYMMDD'), 'YYYYMMDD') = date_key
  )
);
CREATE INDEX IF NOT EXISTS automation_tasks_status_schedule_idx ON automation_tasks(status, scheduled_at);
CREATE INDEX IF NOT EXISTS automation_tasks_date_type_idx ON automation_tasks(date_key, task_type);
CREATE UNIQUE INDEX IF NOT EXISTS automation_tasks_idempotency_unique ON automation_tasks(idempotency_key);
WITH ranked_running_analysis AS (
  SELECT id, row_number() OVER (ORDER BY updated_at DESC, id DESC) AS position
  FROM automation_tasks
  WHERE status = 'running' AND task_type IN ('analysis', 'match-t30-analysis')
)
UPDATE automation_tasks
SET status = 'retrying', current_step = NULL, lock_owner = NULL, lock_expires_at = NULL,
    scheduled_at = NOW(), updated_at = NOW()
WHERE id IN (SELECT id FROM ranked_running_analysis WHERE position > 1);
CREATE UNIQUE INDEX IF NOT EXISTS automation_tasks_single_running_analysis
  ON automation_tasks ((1))
  WHERE status = 'running' AND task_type IN ('analysis', 'match-t30-analysis');
CREATE INDEX IF NOT EXISTS automation_tasks_match_type_status_idx
  ON automation_tasks(match_id, task_type, status);

CREATE TABLE IF NOT EXISTS automation_task_steps (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES automation_tasks(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  input JSONB NOT NULL DEFAULT '{}'::JSONB,
  output JSONB,
  last_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS automation_task_steps_task_idx ON automation_task_steps(task_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS automation_task_steps_task_step_unique ON automation_task_steps(task_id, step_key);
CREATE UNIQUE INDEX IF NOT EXISTS automation_task_steps_idempotency_unique ON automation_task_steps(idempotency_key);

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id SERIAL PRIMARY KEY,
  match_id VARCHAR(20) NOT NULL,
  match_date VARCHAR(8) NOT NULL,
  company_id VARCHAR(20) NOT NULL,
  market_type TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  source TEXT NOT NULL,
  odds JSONB NOT NULL,
  source_observed_at TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT odds_snapshots_match_date_check CHECK (
    match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
  )
);
CREATE INDEX IF NOT EXISTS odds_snapshots_match_time_idx ON odds_snapshots(match_id, match_date, collected_at);
CREATE INDEX IF NOT EXISTS odds_snapshots_market_idx ON odds_snapshots(company_id, market_type, collected_at);
CREATE UNIQUE INDEX IF NOT EXISTS odds_snapshots_idempotency_unique ON odds_snapshots(idempotency_key);

CREATE TABLE IF NOT EXISTS data_quality_records (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  date_key VARCHAR(8) NOT NULL,
  dimension TEXT NOT NULL,
  status TEXT NOT NULL,
  completeness_score REAL,
  source TEXT NOT NULL,
  source_observed_at TIMESTAMPTZ,
  latency_ms INTEGER,
  issue_codes JSONB NOT NULL DEFAULT '[]'::JSONB,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT data_quality_records_date_key_check CHECK (
    date_key ~ '^[0-9]{8}$' AND to_char(to_date(date_key, 'YYYYMMDD'), 'YYYYMMDD') = date_key
  ),
  CONSTRAINT data_quality_records_completeness_check CHECK (
    completeness_score IS NULL OR completeness_score BETWEEN 0 AND 1
  )
);
CREATE INDEX IF NOT EXISTS data_quality_records_entity_idx
  ON data_quality_records(entity_type, entity_id, checked_at);
CREATE INDEX IF NOT EXISTS data_quality_records_status_idx ON data_quality_records(status, date_key);
CREATE UNIQUE INDEX IF NOT EXISTS data_quality_records_observation_unique
  ON data_quality_records(entity_type, entity_id, date_key, dimension, source, checked_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  request_id TEXT,
  idempotency_key TEXT,
  old_value JSONB,
  new_value JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_logs_object_idx ON audit_logs(object_type, object_id, created_at);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_id, created_at);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action, created_at);

CREATE TABLE IF NOT EXISTS migration_duplicate_archive (
  id SERIAL PRIMARY KEY,
  migration_version TEXT NOT NULL,
  table_name TEXT NOT NULL,
  natural_key JSONB NOT NULL,
  retained_id TEXT NOT NULL,
  archived_id TEXT NOT NULL,
  archived_row JSONB NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS migration_duplicate_archive_lookup_idx
  ON migration_duplicate_archive(table_name, archived_at);
CREATE UNIQUE INDEX IF NOT EXISTS migration_duplicate_archive_row_unique
  ON migration_duplicate_archive(migration_version, table_name, archived_id);

CREATE TABLE IF NOT EXISTS match_results (
  id SERIAL PRIMARY KEY,
  match_id VARCHAR(20) NOT NULL,
  match_date VARCHAR(8) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  home_score INTEGER,
  away_score INTEGER,
  home_half_score INTEGER,
  away_half_score INTEGER,
  score_source TEXT,
  observed_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT match_results_match_date_check CHECK (
    match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
  )
);
CREATE INDEX IF NOT EXISTS match_results_match_date_idx ON match_results(match_date);
CREATE INDEX IF NOT EXISTS match_results_status_idx ON match_results(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS match_results_match_date_unique ON match_results(match_id, match_date);

DO $$
DECLARE
  prediction_table TEXT;
  market_name TEXT;
BEGIN
  FOREACH prediction_table IN ARRAY ARRAY['prediction_results', 'prediction_results_backtest'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS prediction_revision INTEGER', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS handicap_settlement_line REAL', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS total_settlement_line REAL', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS handicap_snapshot_id INTEGER', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS total_snapshot_id INTEGER', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS handicap_settlement_basis TEXT', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS total_settlement_basis TEXT', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS handicap_selection TEXT', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS total_selection TEXT', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS actual_score_margin INTEGER', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS actual_total_goals INTEGER', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_output JSONB', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_model_version TEXT', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_calibration_version TEXT', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_source_observed_at TIMESTAMPTZ', prediction_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_quality_status TEXT NOT NULL DEFAULT ''unavailable''', prediction_table);
    FOREACH market_name IN ARRAY ARRAY['handicap', 'total'] LOOP
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT', prediction_table, market_name || '_auto_outcome');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I BOOLEAN', prediction_table, market_name || '_auto_is_correct');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I BOOLEAN', prediction_table, market_name || '_manual_is_correct');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I BOOLEAN', prediction_table, market_name || '_effective_is_correct');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT NOT NULL DEFAULT ''pending''', prediction_table, market_name || '_automatic_status');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT NOT NULL DEFAULT ''unverified''', prediction_table, market_name || '_effective_status');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT', prediction_table, market_name || '_settlement_reason');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TIMESTAMPTZ', prediction_table, market_name || '_auto_verified_at');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TIMESTAMPTZ', prediction_table, market_name || '_manual_verified_at');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TIMESTAMPTZ', prediction_table, market_name || '_final_verified_at');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT', prediction_table, market_name || '_verified_by');
    END LOOP;
  END LOOP;
END $$;

COMMENT ON COLUMN prediction_results.is_correct IS 'Legacy API compatibility mirror for handicap effective correctness only; never use for total settlement.';
COMMENT ON COLUMN prediction_results_backtest.is_correct IS 'Legacy API compatibility mirror for handicap effective correctness only; never use for total settlement.';
COMMENT ON COLUMN prediction_results.handicap_auto_outcome IS 'Authoritative weighted outcome; half outcomes must be weighted for accuracy rather than reduced to boolean correctness.';
COMMENT ON COLUMN prediction_results.total_auto_outcome IS 'Authoritative weighted outcome; half outcomes must be weighted for accuracy rather than reduced to boolean correctness.';

ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'handicap';
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'handicap';
DROP INDEX IF EXISTS learned_patterns_key_unique;
DROP INDEX IF EXISTS learned_patterns_backtest_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_market_key_unique
  ON learned_patterns(market, pattern_key, league);
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_backtest_market_key_unique
  ON learned_patterns_backtest(market, pattern_key, league);

INSERT INTO schema_migrations(version, description)
VALUES ('0001_canonical_baseline', 'Canonical schema baseline for fresh installations')
ON CONFLICT (version) DO NOTHING;

COMMIT;
