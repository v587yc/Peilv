-- Canonical PostgreSQL/Supabase bootstrap. Safe to run repeatedly on an empty or existing database.
-- Strategy Lab remains default-deny after this schema bootstrap. A privileged
-- operator must separately run infra/local-data/sql/strategy-lab-roles.sql,
-- then grant strategy_lab_writer to a secret-provisioned runtime LOGIN role.
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION '0024 requires service_role; refusing to install permissive RPC ACLs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'automation_task_owner') THEN
    CREATE ROLE automation_task_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  ALTER ROLE automation_task_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END $$;

CREATE OR REPLACE FUNCTION public.ensure_automation_task(p_task JSONB)
RETURNS SETOF public.automation_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ensured public.automation_tasks;
  requested_attempt_count INTEGER;
  requested_max_attempts INTEGER;
  requested_schedule TIMESTAMPTZ;
  requested_updated_at TIMESTAMPTZ;
  requested_date DATE;
BEGIN
  IF p_task IS NULL OR jsonb_typeof(p_task) <> 'object' THEN RAISE EXCEPTION 'p_task must be a JSON object' USING ERRCODE = '22023'; END IF;
  IF NOT (p_task ?& ARRAY['id','task_type','date_key','match_id','source','idempotency_key','status','attempt_count','max_attempts','payload','scheduled_at','updated_at']) THEN RAISE EXCEPTION 'p_task is missing required fields' USING ERRCODE = '22023'; END IF;
  IF NULLIF(p_task->>'id','') IS NULL OR length(p_task->>'id') > 128 OR NULLIF(p_task->>'idempotency_key','') IS NULL OR length(p_task->>'idempotency_key') > 512 OR p_task->>'date_key' !~ '^[0-9]{8}$' THEN RAISE EXCEPTION 'invalid task identity' USING ERRCODE = '22023'; END IF;
  BEGIN requested_date := to_date(p_task->>'date_key','YYYYMMDD'); IF to_char(requested_date,'YYYYMMDD') <> p_task->>'date_key' THEN RAISE EXCEPTION 'invalid date'; END IF; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid task identity' USING ERRCODE = '22023'; END;
  IF p_task->>'task_type' NOT IN ('odds-fetch','crown-snapshot','analysis','match-t30-analysis','verify-learn-report') THEN RAISE EXCEPTION 'invalid task_type' USING ERRCODE = '22023'; END IF;
  IF p_task->>'status' NOT IN ('pending','running','retrying','completed','failed') THEN RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023'; END IF;
  IF p_task->>'source' NOT IN ('production','backtest') THEN RAISE EXCEPTION 'invalid source' USING ERRCODE = '22023'; END IF;
  IF (p_task->>'match_id') IS NOT NULL AND length(p_task->>'match_id') > 20 THEN RAISE EXCEPTION 'invalid match_id' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(p_task->'attempt_count') <> 'number' OR jsonb_typeof(p_task->'max_attempts') <> 'number' OR (p_task->>'attempt_count') !~ '^[0-9]+$' OR (p_task->>'max_attempts') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'invalid attempt bounds' USING ERRCODE = '22023'; END IF;
  BEGIN requested_attempt_count := (p_task->>'attempt_count')::INTEGER; requested_max_attempts := (p_task->>'max_attempts')::INTEGER; IF requested_attempt_count NOT BETWEEN 0 AND 1000 OR requested_max_attempts NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid bounds'; END IF; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid attempt bounds' USING ERRCODE = '22023'; END;
  IF jsonb_typeof(p_task->'payload') <> 'object' OR octet_length((p_task->'payload')::TEXT) > 262144 THEN RAISE EXCEPTION 'payload must be an object no larger than 256KiB' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(p_task->'scheduled_at') <> 'string' OR jsonb_typeof(p_task->'updated_at') <> 'string' THEN RAISE EXCEPTION 'scheduled_at and updated_at must be timestamp strings' USING ERRCODE = '22023'; END IF;
  BEGIN requested_schedule := (p_task->>'scheduled_at')::TIMESTAMPTZ; requested_updated_at := (p_task->>'updated_at')::TIMESTAMPTZ; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid timestamp' USING ERRCODE = '22023'; END;
  INSERT INTO public.automation_tasks(
    id, task_type, date_key, match_id, source, idempotency_key, status,
    attempt_count, max_attempts, payload, scheduled_at, updated_at
  ) VALUES (
    p_task->>'id', p_task->>'task_type', p_task->>'date_key', NULLIF(p_task->>'match_id',''),
    COALESCE(NULLIF(p_task->>'source',''), 'production'), p_task->>'idempotency_key',
    COALESCE(NULLIF(p_task->>'status',''), 'pending'),
    requested_attempt_count,
    requested_max_attempts,
    COALESCE(p_task->'payload', '{}'::JSONB),
    requested_schedule,
    requested_updated_at
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO ensured;
  IF NOT FOUND THEN
    SELECT * INTO ensured FROM public.automation_tasks
    WHERE idempotency_key = p_task->>'idempotency_key';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION '幂等任务查询失败'; END IF;
  IF ensured.task_type IS DISTINCT FROM p_task->>'task_type' OR ensured.date_key IS DISTINCT FROM p_task->>'date_key' OR ensured.match_id IS DISTINCT FROM NULLIF(p_task->>'match_id','') OR ensured.source IS DISTINCT FROM p_task->>'source' THEN RAISE EXCEPTION 'idempotency key payload conflict' USING ERRCODE = 'P0001', DETAIL = 'IDEMPOTENCY_PAYLOAD_CONFLICT'; END IF;
  RETURN NEXT ensured;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_automation_task(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_automation_task(JSONB) TO service_role;
ALTER FUNCTION public.ensure_automation_task(JSONB) OWNER TO automation_task_owner;
GRANT SELECT, INSERT ON public.automation_tasks TO automation_task_owner;

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
  hash_version TEXT NOT NULL DEFAULT 'legacy-json-v1',
  canonical_content_hash TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT odds_snapshots_match_date_check CHECK (
    match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
  ),
  CONSTRAINT odds_snapshots_hash_contract_check CHECK (
    (hash_version='legacy-json-v1' AND canonical_content_hash IS NULL)
    OR (hash_version='canonical-json-v2' AND canonical_content_hash IS NOT NULL AND canonical_content_hash~'^[0-9a-f]{64}$' AND content_hash=canonical_content_hash)
  )
);
CREATE INDEX IF NOT EXISTS odds_snapshots_match_time_idx ON odds_snapshots(match_id, match_date, collected_at);
CREATE INDEX IF NOT EXISTS odds_snapshots_market_idx ON odds_snapshots(company_id, market_type, collected_at);
CREATE UNIQUE INDEX IF NOT EXISTS odds_snapshots_idempotency_unique ON odds_snapshots(idempotency_key);
CREATE INDEX IF NOT EXISTS odds_snapshots_strategy_lab_evidence_idx ON odds_snapshots(match_id,match_date,company_id,market_type,snapshot_type,source_observed_at,collected_at,hash_version);

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

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'operator', 'auditor')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_users_username_format CHECK (username ~ '^[a-z0-9._-]{3,64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_unique ON admin_users(LOWER(username));
CREATE INDEX IF NOT EXISTS admin_users_role_active_idx ON admin_users(role, is_active);
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'operator', 'auditor')),
  username TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_sessions_user_idx ON admin_sessions(admin_user_id, expires_at);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at) WHERE revoked_at IS NULL;
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION bootstrap_first_admin(
  p_id UUID,
  p_username TEXT,
  p_display_name TEXT,
  p_password_hash TEXT
)
RETURNS SETOF admin_users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_identity_guardrails', 0));
  IF EXISTS (SELECT 1 FROM admin_users) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_ALREADY_INITIALIZED';
  END IF;
  RETURN QUERY
  INSERT INTO admin_users(id, username, display_name, password_hash, role, is_active)
  VALUES (p_id, p_username, p_display_name, p_password_hash, 'super_admin', TRUE)
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION update_admin_user_guarded(
  p_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_display_name TEXT DEFAULT NULL,
  p_role TEXT DEFAULT NULL,
  p_is_active BOOLEAN DEFAULT NULL,
  p_password_hash TEXT DEFAULT NULL
)
RETURNS SETOF admin_users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_user_row admin_users%ROWTYPE;
  next_role TEXT;
  next_active BOOLEAN;
  revoke_sessions BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_identity_guardrails', 0));
  SELECT * INTO current_user_row FROM admin_users WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_NOT_FOUND';
  END IF;
  IF p_expected_updated_at IS NULL OR current_user_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_UPDATE_CONFLICT';
  END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('super_admin', 'operator', 'auditor') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_ROLE_INVALID';
  END IF;
  next_role := COALESCE(p_role, current_user_row.role);
  next_active := COALESCE(p_is_active, current_user_row.is_active);
  IF current_user_row.role = 'super_admin' AND current_user_row.is_active
     AND (next_role <> 'super_admin' OR NOT next_active)
     AND NOT EXISTS (SELECT 1 FROM admin_users WHERE id <> p_id AND role = 'super_admin' AND is_active) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LAST_ACTIVE_SUPER_ADMIN';
  END IF;
  revoke_sessions := p_password_hash IS NOT NULL
    OR next_role IS DISTINCT FROM current_user_row.role
    OR next_active IS DISTINCT FROM current_user_row.is_active;
  RETURN QUERY
  UPDATE admin_users
  SET display_name = COALESCE(p_display_name, display_name),
      role = next_role,
      is_active = next_active,
      password_hash = COALESCE(p_password_hash, password_hash),
      updated_at = clock_timestamp()
  WHERE id = p_id AND updated_at = p_expected_updated_at
  RETURNING *;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_UPDATE_CONFLICT';
  END IF;
  IF revoke_sessions THEN
    UPDATE admin_sessions SET revoked_at = NOW() WHERE admin_user_id = p_id AND revoked_at IS NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION bootstrap_first_admin(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_admin_user_guarded(UUID, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION bootstrap_first_admin(UUID, TEXT, TEXT, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION update_admin_user_guarded(UUID, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT) TO service_role;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS admin_login_rate_limits (
  key_hash CHAR(64) PRIMARY KEY,
  key_kind TEXT NOT NULL CHECK (key_kind IN ('username', 'ip')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_login_rate_limits_cleanup_idx ON admin_login_rate_limits(updated_at);
ALTER TABLE admin_login_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION check_admin_login_rate_limit(p_username_key CHAR(64), p_ip_key CHAR(64) DEFAULT NULL)
RETURNS TABLE(allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE retry_seconds INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_rate_limit:' || p_username_key, 0));
  IF p_ip_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_rate_limit:' || p_ip_key, 0)); END IF;
  SELECT COALESCE(MAX(GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())))::INTEGER)), 0) INTO retry_seconds
  FROM admin_login_rate_limits WHERE key_hash IN (p_username_key, p_ip_key) AND locked_until > NOW();
  RETURN QUERY SELECT retry_seconds = 0, retry_seconds;
END; $$;

CREATE OR REPLACE FUNCTION record_admin_login_failure(p_username_key CHAR(64), p_ip_key CHAR(64) DEFAULT NULL)
RETURNS TABLE(allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE current_key CHAR(64); current_kind TEXT; current_threshold INTEGER; next_failures INTEGER; lock_seconds INTEGER; max_retry INTEGER := 0;
BEGIN
  FOR current_key, current_kind, current_threshold IN
    SELECT p_username_key, 'username', 5 UNION ALL SELECT p_ip_key, 'ip', 20 WHERE p_ip_key IS NOT NULL
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_rate_limit:' || current_key, 0));
    INSERT INTO admin_login_rate_limits(key_hash,key_kind,failure_count,window_started_at,updated_at)
    VALUES(current_key,current_kind,0,NOW(),NOW()) ON CONFLICT(key_hash) DO NOTHING;
    UPDATE admin_login_rate_limits SET
      failure_count=CASE WHEN window_started_at < NOW()-INTERVAL '15 minutes' THEN 1 ELSE failure_count+1 END,
      window_started_at=CASE WHEN window_started_at < NOW()-INTERVAL '15 minutes' THEN NOW() ELSE window_started_at END,
      updated_at=NOW() WHERE key_hash=current_key RETURNING failure_count INTO next_failures;
    lock_seconds:=CASE WHEN next_failures<current_threshold THEN 0 ELSE LEAST(300,5*(2^LEAST(6,next_failures-current_threshold)))::INTEGER END;
    IF lock_seconds>0 THEN
      UPDATE admin_login_rate_limits SET locked_until=GREATEST(COALESCE(locked_until,NOW()),NOW()+make_interval(secs=>lock_seconds)),updated_at=NOW() WHERE key_hash=current_key;
      max_retry:=GREATEST(max_retry,lock_seconds);
    END IF;
  END LOOP;
  RETURN QUERY SELECT max_retry=0,max_retry;
END; $$;

CREATE OR REPLACE FUNCTION clear_admin_login_failures(p_username_key CHAR(64), p_ip_key CHAR(64) DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN DELETE FROM admin_login_rate_limits WHERE key_hash IN (p_username_key,p_ip_key); END; $$;
REVOKE ALL ON TABLE admin_login_rate_limits FROM PUBLIC;
REVOKE ALL ON FUNCTION check_admin_login_rate_limit(CHAR,CHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_admin_login_failure(CHAR,CHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION clear_admin_login_failures(CHAR,CHAR) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION check_admin_login_rate_limit(CHAR,CHAR) TO service_role;
  GRANT EXECUTE ON FUNCTION record_admin_login_failure(CHAR,CHAR) TO service_role;
  GRANT EXECUTE ON FUNCTION clear_admin_login_failures(CHAR,CHAR) TO service_role;
END IF; END $$;


CREATE TABLE IF NOT EXISTS admin_login_attempt_buckets (
  key_hash CHAR(64) PRIMARY KEY,
  key_kind TEXT NOT NULL CHECK (key_kind IN ('global', 'source', 'source_subject', 'unknown', 'account')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_login_attempt_buckets_cleanup_idx ON admin_login_attempt_buckets(updated_at);

CREATE TABLE IF NOT EXISTS admin_login_attempt_reservations (
  token_hash CHAR(64) PRIMARY KEY,
  global_key CHAR(64) NOT NULL,
  source_key CHAR(64),
  subject_key CHAR(64) NOT NULL,
  source_subject_key CHAR(64),
  subject_known BOOLEAN NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_expiry_idx ON admin_login_attempt_reservations(expires_at);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_global_idx ON admin_login_attempt_reservations(global_key, expires_at);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_source_idx ON admin_login_attempt_reservations(source_key, expires_at);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_subject_idx ON admin_login_attempt_reservations(subject_key, expires_at);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_source_subject_idx ON admin_login_attempt_reservations(source_subject_key, expires_at);
ALTER TABLE admin_login_attempt_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_login_attempt_reservations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION reserve_admin_login_attempt(
  p_token_hash CHAR(64), p_global_key CHAR(64), p_source_key CHAR(64),
  p_subject_key CHAR(64), p_source_subject_key CHAR(64), p_subject_known BOOLEAN
)
RETURNS TABLE(allowed BOOLEAN, retry_after_seconds INTEGER, reservation_key CHAR(64))
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE active_count INTEGER; attempts INTEGER; bucket_key CHAR(64); bucket_kind TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_reservations', 0));
  DELETE FROM admin_login_attempt_reservations WHERE token_hash IN (
    SELECT token_hash FROM admin_login_attempt_reservations WHERE expires_at <= NOW() LIMIT 100
  );
  DELETE FROM admin_login_attempt_buckets WHERE key_hash IN (
    SELECT key_hash FROM admin_login_attempt_buckets
    WHERE updated_at < NOW() - INTERVAL '24 hours' AND key_kind <> 'global' LIMIT 100
  );
  IF EXISTS (SELECT 1 FROM admin_login_attempt_reservations WHERE token_hash = p_token_hash) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='RESERVATION_REPLAY';
  END IF;

  FOR bucket_key, bucket_kind IN
    SELECT p_global_key, 'global' UNION ALL
    SELECT p_source_key, 'source' WHERE p_source_key IS NOT NULL UNION ALL
    SELECT p_source_subject_key, 'source_subject' WHERE p_source_subject_key IS NOT NULL UNION ALL
    SELECT p_subject_key, CASE WHEN p_subject_known THEN 'account' ELSE 'unknown' END
  LOOP
    INSERT INTO admin_login_attempt_buckets(key_hash,key_kind) VALUES(bucket_key,bucket_kind)
    ON CONFLICT(key_hash) DO NOTHING;
    UPDATE admin_login_attempt_buckets SET
      attempt_count=CASE WHEN window_started_at < NOW()-INTERVAL '1 minute' THEN 1 ELSE attempt_count+1 END,
      window_started_at=CASE WHEN window_started_at < NOW()-INTERVAL '1 minute' THEN NOW() ELSE window_started_at END,
      updated_at=NOW() WHERE key_hash=bucket_key RETURNING attempt_count INTO attempts;
    IF bucket_kind='global' AND attempts>120 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
    IF bucket_kind='source' AND attempts>30 THEN RETURN QUERY SELECT FALSE,2,NULL::CHAR(64); RETURN; END IF;
    IF bucket_kind='source_subject' AND attempts>10 THEN RETURN QUERY SELECT FALSE,3,NULL::CHAR(64); RETURN; END IF;
    IF bucket_kind='unknown' AND attempts>30 THEN RETURN QUERY SELECT FALSE,2,NULL::CHAR(64); RETURN; END IF;
  END LOOP;

  SELECT COUNT(*)::INTEGER INTO active_count FROM admin_login_attempt_reservations WHERE expires_at>NOW() AND global_key=p_global_key;
  IF active_count>=12 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
  IF p_source_key IS NOT NULL THEN
    SELECT COUNT(*)::INTEGER INTO active_count FROM admin_login_attempt_reservations WHERE expires_at>NOW() AND source_key=p_source_key;
    IF active_count>=4 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
  END IF;
  IF p_source_subject_key IS NOT NULL THEN
    SELECT COUNT(*)::INTEGER INTO active_count FROM admin_login_attempt_reservations WHERE expires_at>NOW() AND source_subject_key=p_source_subject_key;
    IF active_count>=2 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
  ELSIF NOT p_subject_known THEN
    SELECT COUNT(*)::INTEGER INTO active_count FROM admin_login_attempt_reservations WHERE expires_at>NOW() AND subject_key=p_subject_key;
    IF active_count>=4 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
  END IF;

  INSERT INTO admin_login_attempt_reservations(token_hash,global_key,source_key,subject_key,source_subject_key,subject_known,expires_at)
  VALUES(p_token_hash,p_global_key,p_source_key,p_subject_key,p_source_subject_key,p_subject_known,NOW()+INTERVAL '15 seconds');
  RETURN QUERY SELECT TRUE,0,p_token_hash;
END; $$;

CREATE OR REPLACE FUNCTION settle_admin_login_attempt(p_token_hash CHAR(64), p_succeeded BOOLEAN)
RETURNS TABLE(settled BOOLEAN, audit_failure BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE reservation admin_login_attempt_reservations%ROWTYPE; next_failures INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_reservations', 0));
  SELECT * INTO reservation FROM admin_login_attempt_reservations WHERE token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT FALSE,FALSE; RETURN; END IF;
  DELETE FROM admin_login_attempt_reservations WHERE token_hash=p_token_hash;
  IF p_succeeded IS NULL THEN
    RETURN QUERY SELECT TRUE,FALSE; RETURN;
  END IF;
  IF p_succeeded THEN
    UPDATE admin_login_attempt_buckets SET failure_count=0,updated_at=NOW()
    WHERE key_hash IN(reservation.subject_key,reservation.source_subject_key);
    RETURN QUERY SELECT TRUE,FALSE; RETURN;
  END IF;
  UPDATE admin_login_attempt_buckets SET failure_count=failure_count+1,updated_at=NOW()
  WHERE key_hash=reservation.subject_key RETURNING failure_count INTO next_failures;
  RETURN QUERY SELECT TRUE,(next_failures=1 OR (next_failures & (next_failures-1))=0 OR next_failures%25=0);
END; $$;

CREATE OR REPLACE FUNCTION cleanup_admin_login_attempts(p_limit INTEGER DEFAULT 500)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE removed INTEGER:=0; count_now INTEGER;
BEGIN
  WITH deleted AS (DELETE FROM admin_login_attempt_reservations WHERE token_hash IN
    (SELECT token_hash FROM admin_login_attempt_reservations WHERE expires_at<=NOW() LIMIT LEAST(GREATEST(p_limit,1),5000)) RETURNING 1)
  SELECT COUNT(*) INTO count_now FROM deleted; removed:=removed+count_now;
  WITH deleted AS (DELETE FROM admin_login_attempt_buckets WHERE key_hash IN
    (SELECT key_hash FROM admin_login_attempt_buckets WHERE updated_at<NOW()-INTERVAL '24 hours' AND key_kind<>'global' LIMIT LEAST(GREATEST(p_limit,1),5000)) RETURNING 1)
  SELECT COUNT(*) INTO count_now FROM deleted; RETURN removed+count_now;
END; $$;

REVOKE ALL ON TABLE admin_login_attempt_buckets,admin_login_attempt_reservations FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_admin_login_attempt(CHAR,CHAR,CHAR,CHAR,CHAR,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_admin_login_attempt(CHAR,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION cleanup_admin_login_attempts(INTEGER) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION reserve_admin_login_attempt(CHAR,CHAR,CHAR,CHAR,CHAR,BOOLEAN) TO service_role;
  GRANT EXECUTE ON FUNCTION settle_admin_login_attempt(CHAR,BOOLEAN) TO service_role;
  GRANT EXECUTE ON FUNCTION cleanup_admin_login_attempts(INTEGER) TO service_role;
END IF; END $$;
INSERT INTO schema_migrations(version,description) VALUES('0012_admin_login_reservations','Replace login check-record window with atomic bounded reservations') ON CONFLICT(version) DO NOTHING;
INSERT INTO schema_migrations(version,description) VALUES('0013_admin_user_optimistic_concurrency','Require administrator version preconditions for guarded updates') ON CONFLICT(version) DO NOTHING;


CREATE OR REPLACE FUNCTION reserve_admin_login_attempt_v2(
  p_reservation_key CHAR(64),
  p_global_key CHAR(64),
  p_source_key CHAR(64) DEFAULT NULL
)
RETURNS TABLE(allowed BOOLEAN, retry_after_seconds INTEGER, reservation_key CHAR(64))
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  active_count INTEGER;
  source_attempts INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_uniform_reservations', 0));

  DELETE FROM admin_login_attempt_reservations
  WHERE token_hash IN (
    SELECT token_hash FROM admin_login_attempt_reservations
    WHERE expires_at <= NOW() ORDER BY expires_at LIMIT 100
  );
  DELETE FROM admin_login_attempt_buckets
  WHERE key_hash IN (
    SELECT key_hash FROM admin_login_attempt_buckets
    WHERE updated_at < NOW() - INTERVAL '24 hours' AND key_kind <> 'global'
    ORDER BY updated_at LIMIT 100
  );

  IF EXISTS (SELECT 1 FROM admin_login_attempt_reservations WHERE token_hash = p_reservation_key) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESERVATION_REPLAY';
  END IF;

  SELECT COUNT(*)::INTEGER INTO active_count
  FROM admin_login_attempt_reservations
  WHERE expires_at > NOW() AND global_key = p_global_key;
  IF active_count >= 12 THEN
    RETURN QUERY SELECT FALSE, 1, NULL::CHAR(64);
    RETURN;
  END IF;

  IF p_source_key IS NOT NULL THEN
    INSERT INTO admin_login_attempt_buckets(key_hash, key_kind)
    VALUES (p_source_key, 'source') ON CONFLICT (key_hash) DO NOTHING;
    UPDATE admin_login_attempt_buckets
    SET attempt_count = CASE WHEN window_started_at < NOW() - INTERVAL '1 minute' THEN 1 ELSE attempt_count + 1 END,
        window_started_at = CASE WHEN window_started_at < NOW() - INTERVAL '1 minute' THEN NOW() ELSE window_started_at END,
        updated_at = NOW()
    WHERE key_hash = p_source_key
    RETURNING attempt_count INTO source_attempts;
    IF source_attempts > 30 THEN
      RETURN QUERY SELECT FALSE, 2, NULL::CHAR(64);
      RETURN;
    END IF;
    SELECT COUNT(*)::INTEGER INTO active_count
    FROM admin_login_attempt_reservations
    WHERE expires_at > NOW() AND source_key = p_source_key;
    IF active_count >= 4 THEN
      RETURN QUERY SELECT FALSE, 1, NULL::CHAR(64);
      RETURN;
    END IF;
  END IF;

  INSERT INTO admin_login_attempt_reservations(
    token_hash, global_key, source_key, subject_key, source_subject_key,
    subject_known, expires_at
  ) VALUES (
    p_reservation_key, p_global_key, p_source_key, p_global_key, NULL,
    FALSE, NOW() + INTERVAL '15 seconds'
  );
  RETURN QUERY SELECT TRUE, 0, p_reservation_key;
END;
$$;

CREATE OR REPLACE FUNCTION settle_admin_login_attempt_v2(
  p_reservation_key CHAR(64),
  p_succeeded BOOLEAN
)
RETURNS TABLE(settled BOOLEAN, audit_failure BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  reservation admin_login_attempt_reservations%ROWTYPE;
  aggregate_failures INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_uniform_reservations', 0));
  SELECT * INTO reservation
  FROM admin_login_attempt_reservations
  WHERE token_hash = p_reservation_key FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, FALSE;
    RETURN;
  END IF;
  DELETE FROM admin_login_attempt_reservations WHERE token_hash = p_reservation_key;
  IF p_succeeded IS NULL OR p_succeeded THEN
    RETURN QUERY SELECT TRUE, FALSE;
    RETURN;
  END IF;

  INSERT INTO admin_login_attempt_buckets(key_hash, key_kind, failure_count)
  VALUES (reservation.global_key, 'global', 1)
  ON CONFLICT (key_hash) DO UPDATE
  SET failure_count = admin_login_attempt_buckets.failure_count + 1,
      updated_at = NOW()
  RETURNING failure_count INTO aggregate_failures;
  RETURN QUERY SELECT TRUE,
    (aggregate_failures = 1 OR (aggregate_failures & (aggregate_failures - 1)) = 0 OR aggregate_failures % 100 = 0);
END;
$$;

REVOKE ALL ON FUNCTION reserve_admin_login_attempt_v2(CHAR, CHAR, CHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_admin_login_attempt_v2(CHAR, BOOLEAN) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION reserve_admin_login_attempt_v2(CHAR, CHAR, CHAR) TO service_role;
    GRANT EXECUTE ON FUNCTION settle_admin_login_attempt_v2(CHAR, BOOLEAN) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migrations(version, description)
VALUES ('0014_admin_login_uniform_reservations', 'Make login admission account-agnostic and global-concurrency-only')
ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS management_command_receipts (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'effect_started', 'effect_succeeded', 'audit_pending', 'completed', 'failed')),
  result_reference JSONB,
  safe_error TEXT,
  actor_id TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (action, idempotency_key)
);
CREATE INDEX IF NOT EXISTS management_command_receipts_status_idx
  ON management_command_receipts(status, updated_at);
ALTER TABLE management_command_receipts ADD COLUMN IF NOT EXISTS audit_context JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_command_success_unique
  ON audit_logs(action, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND action LIKE '%.succeeded';

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

-- Administrator lifecycle writes and their audit events are committed by one
-- database transaction. Keep this bootstrap contract aligned with migration 0015.
CREATE OR REPLACE FUNCTION create_admin_user_audited(
  p_id UUID, p_username TEXT, p_display_name TEXT, p_password_hash TEXT,
  p_role TEXT, p_actor_id TEXT, p_request_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE created admin_users%ROWTYPE;
BEGIN
  INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
  VALUES (p_actor_id, 'admin', 'admin.user_create.requested', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'pending'));
  BEGIN
    INSERT INTO admin_users(id, username, display_name, password_hash, role, is_active)
    VALUES (p_id, p_username, p_display_name, p_password_hash, p_role, TRUE)
    RETURNING * INTO created;
  EXCEPTION
    WHEN unique_violation THEN
      INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
      VALUES (p_actor_id, 'admin', 'admin.user_create.failed', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'failed', 'errorCode', 'ADMIN_ALREADY_EXISTS'));
      RETURN jsonb_build_object('ok', FALSE, 'error_code', 'ADMIN_ALREADY_EXISTS');
    WHEN OTHERS THEN
      INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
      VALUES (p_actor_id, 'admin', 'admin.user_create.failed', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'failed', 'errorCode', 'ADMIN_CREATE_FAILED'));
      RETURN jsonb_build_object('ok', FALSE, 'error_code', 'ADMIN_CREATE_FAILED');
  END;
  INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, new_value, metadata)
  VALUES (p_actor_id, 'admin', 'admin.user_create.succeeded', 'admin_user', created.id::TEXT, p_request_id,
    jsonb_build_object('id', created.id, 'username', created.username, 'displayName', created.display_name, 'role', created.role, 'isActive', created.is_active),
    jsonb_build_object('status', 'succeeded'));
  RETURN jsonb_build_object('ok', TRUE, 'user', to_jsonb(created) - 'password_hash');
END $$;

CREATE OR REPLACE FUNCTION update_admin_user_audited(
  p_id UUID, p_expected_updated_at TIMESTAMPTZ, p_display_name TEXT,
  p_role TEXT, p_is_active BOOLEAN, p_password_hash TEXT,
  p_actor_id TEXT, p_request_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  previous admin_users%ROWTYPE; updated admin_users%ROWTYPE;
  next_role TEXT; next_active BOOLEAN; failure_code TEXT;
BEGIN
  INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
  VALUES (p_actor_id, 'admin', 'admin.user_update.requested', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'pending'));
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('admin_identity_guardrails', 0));
    SELECT * INTO previous FROM admin_users WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_NOT_FOUND'; END IF;
    IF p_expected_updated_at IS NULL OR previous.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_UPDATE_CONFLICT';
    END IF;
    IF p_role IS NOT NULL AND p_role NOT IN ('super_admin', 'operator', 'auditor') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_ROLE_INVALID';
    END IF;
    next_role := COALESCE(p_role, previous.role);
    next_active := COALESCE(p_is_active, previous.is_active);
    IF previous.role = 'super_admin' AND previous.is_active
       AND (next_role <> 'super_admin' OR NOT next_active)
       AND NOT EXISTS (SELECT 1 FROM admin_users WHERE id <> p_id AND role = 'super_admin' AND is_active) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LAST_ACTIVE_SUPER_ADMIN';
    END IF;
    UPDATE admin_users SET display_name = COALESCE(p_display_name, display_name),
      role = next_role, is_active = next_active,
      password_hash = COALESCE(p_password_hash, password_hash), updated_at = clock_timestamp()
    WHERE id = p_id AND updated_at = p_expected_updated_at RETURNING * INTO updated;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_UPDATE_CONFLICT'; END IF;
    IF p_password_hash IS NOT NULL OR next_role IS DISTINCT FROM previous.role OR next_active IS DISTINCT FROM previous.is_active THEN
      UPDATE admin_sessions SET revoked_at = NOW() WHERE admin_user_id = p_id AND revoked_at IS NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    failure_code := CASE SQLERRM
      WHEN 'ADMIN_NOT_FOUND' THEN 'ADMIN_NOT_FOUND'
      WHEN 'ADMIN_UPDATE_CONFLICT' THEN 'ADMIN_UPDATE_CONFLICT'
      WHEN 'LAST_ACTIVE_SUPER_ADMIN' THEN 'LAST_ACTIVE_SUPER_ADMIN'
      WHEN 'ADMIN_ROLE_INVALID' THEN 'ADMIN_ROLE_INVALID'
      ELSE 'ADMIN_UPDATE_FAILED' END;
    INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
    VALUES (p_actor_id, 'admin', 'admin.user_update.failed', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'failed', 'errorCode', failure_code));
    RETURN jsonb_build_object('ok', FALSE, 'error_code', failure_code);
  END;
  INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, old_value, new_value, metadata)
  VALUES (p_actor_id, 'admin', 'admin.user_update.succeeded', 'admin_user', p_id::TEXT, p_request_id,
    to_jsonb(previous) - 'password_hash', to_jsonb(updated) - 'password_hash',
    jsonb_build_object('status', 'succeeded', 'passwordChanged', p_password_hash IS NOT NULL));
  RETURN jsonb_build_object('ok', TRUE, 'user', to_jsonb(updated) - 'password_hash');
END $$;

REVOKE ALL ON FUNCTION create_admin_user_audited(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_admin_user_audited(UUID, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC;

-- Atomic quota admission for backtests. Keep this bootstrap contract aligned
-- with migration 0016 and the full backtest_jobs row shape.
CREATE OR REPLACE FUNCTION claim_backtest_job(p_job JSONB, p_max_concurrent INTEGER, p_resume BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id TEXT := p_job->>'id'; v_running INTEGER; v_existing_status TEXT;
BEGIN
  IF v_id IS NULL OR v_id = '' OR p_max_concurrent < 1 THEN RAISE EXCEPTION 'invalid backtest claim'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('backtest_jobs:admission', 0));
  SELECT status INTO v_existing_status FROM backtest_jobs WHERE id = v_id FOR UPDATE;
  IF FOUND AND v_existing_status IN ('running', 'cancelling') THEN
    RETURN jsonb_build_object('claimed', FALSE, 'reason', 'already_active');
  END IF;
  SELECT COUNT(*) INTO v_running FROM backtest_jobs WHERE status IN ('running', 'cancelling');
  IF v_running >= p_max_concurrent THEN RETURN jsonb_build_object('claimed', FALSE, 'reason', 'quota_exceeded'); END IF;
  IF p_resume AND v_existing_status IS NULL THEN RETURN jsonb_build_object('claimed', FALSE, 'reason', 'not_found'); END IF;
  INSERT INTO backtest_jobs(
    id, idempotency_key, status, current_step, start_date, end_date, "current_date",
    total_dates, processed_dates, total_matches, analyzed_matches, verified_matches,
    correct_matches, accuracy, log, result, last_error, attempt_count, max_attempts,
    lock_owner, lock_expires_at, started_at, ended_at, updated_at
  ) VALUES (
    v_id, NULLIF(p_job->>'idempotency_key', ''), 'running', COALESCE(p_job->>'current_step', 'queued'),
    p_job->>'start_date', p_job->>'end_date', p_job->>'current_date',
    COALESCE((p_job->>'total_dates')::INTEGER, 0), COALESCE((p_job->>'processed_dates')::INTEGER, 0),
    COALESCE((p_job->>'total_matches')::INTEGER, 0), COALESCE((p_job->>'analyzed_matches')::INTEGER, 0),
    COALESCE((p_job->>'verified_matches')::INTEGER, 0), COALESCE((p_job->>'correct_matches')::INTEGER, 0),
    COALESCE(p_job->>'accuracy', '0%'), COALESCE(p_job->'log', '[]'::JSONB), p_job->'result', NULL,
    COALESCE((p_job->>'attempt_count')::INTEGER, 1), COALESCE((p_job->>'max_attempts')::INTEGER, 3),
    NULLIF(p_job->>'lock_owner', ''), NULLIF(p_job->>'lock_expires_at', '')::TIMESTAMPTZ,
    COALESCE((p_job->>'started_at')::TIMESTAMPTZ, NOW()), NULL, NOW()
  ) ON CONFLICT (id) DO UPDATE SET
    status = 'running', current_step = EXCLUDED.current_step,
    start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date, "current_date" = EXCLUDED."current_date",
    total_dates = EXCLUDED.total_dates, processed_dates = EXCLUDED.processed_dates,
    total_matches = EXCLUDED.total_matches, analyzed_matches = EXCLUDED.analyzed_matches,
    verified_matches = EXCLUDED.verified_matches, correct_matches = EXCLUDED.correct_matches,
    accuracy = EXCLUDED.accuracy, log = EXCLUDED.log, result = EXCLUDED.result,
    last_error = NULL, attempt_count = backtest_jobs.attempt_count + 1,
    max_attempts = EXCLUDED.max_attempts, lock_owner = EXCLUDED.lock_owner,
    lock_expires_at = EXCLUDED.lock_expires_at, ended_at = NULL, updated_at = NOW();
  RETURN jsonb_build_object('claimed', TRUE, 'job_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION heartbeat_backtest_job(p_job_id TEXT, p_lock_owner TEXT, p_lease_seconds INTEGER DEFAULT 60)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  UPDATE backtest_jobs SET lock_expires_at = NOW() + make_interval(secs => GREATEST(10, LEAST(p_lease_seconds, 300))), updated_at = NOW()
  WHERE id = p_job_id AND status IN ('running', 'cancelling') AND lock_owner = p_lock_owner;
  GET DIAGNOSTICS v_updated = ROW_COUNT; RETURN v_updated = 1;
END $$;
CREATE OR REPLACE FUNCTION record_management_command_effect_result(p_action TEXT, p_idempotency_key TEXT, p_result JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  UPDATE management_command_receipts SET result_reference=p_result, audit_context=COALESCE(audit_context,'{}'::JSONB)||'{"effectSucceeded":true}'::JSONB, updated_at=NOW()
  WHERE action=p_action AND idempotency_key=p_idempotency_key AND status='effect_started';
  GET DIAGNOSTICS v_updated = ROW_COUNT; RETURN v_updated = 1;
END $$;
CREATE OR REPLACE FUNCTION fail_claimed_backtest_job(p_job_id TEXT, p_lock_owner TEXT, p_safe_error TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  UPDATE backtest_jobs SET status='error', current_step='startup_failed', last_error=LEFT(p_safe_error,500), lock_owner=NULL, lock_expires_at=NULL, ended_at=NOW(), updated_at=NOW()
  WHERE id=p_job_id AND status='running' AND lock_owner=p_lock_owner;
  GET DIAGNOSTICS v_updated = ROW_COUNT; RETURN v_updated = 1;
END $$;
CREATE OR REPLACE FUNCTION reconcile_expired_backtest_jobs(p_limit INTEGER DEFAULT 25)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  WITH expired AS (SELECT id FROM backtest_jobs WHERE status IN ('running','cancelling') AND lock_expires_at < NOW() ORDER BY lock_expires_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(1,LEAST(p_limit,100)))
  UPDATE backtest_jobs j SET status='error', current_step='lease_expired', last_error='回测任务租约过期，已由对账任务回收', lock_owner=NULL, lock_expires_at=NULL, ended_at=NOW(), updated_at=NOW() FROM expired WHERE j.id=expired.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT; RETURN v_updated;
END $$;
CREATE OR REPLACE FUNCTION persist_claimed_backtest_job(p_job JSONB, p_lock_owner TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  UPDATE backtest_jobs AS jobs SET
    status=p_job->>'status', current_step=p_job->>'current_step', "current_date"=p_job->>'current_date',
    total_dates=COALESCE((p_job->>'total_dates')::INTEGER,jobs.total_dates), processed_dates=COALESCE((p_job->>'processed_dates')::INTEGER,jobs.processed_dates),
    total_matches=COALESCE((p_job->>'total_matches')::INTEGER,jobs.total_matches), analyzed_matches=COALESCE((p_job->>'analyzed_matches')::INTEGER,jobs.analyzed_matches),
    verified_matches=COALESCE((p_job->>'verified_matches')::INTEGER,jobs.verified_matches), correct_matches=COALESCE((p_job->>'correct_matches')::INTEGER,jobs.correct_matches),
    accuracy=COALESCE(p_job->>'accuracy',jobs.accuracy), log=COALESCE(p_job->'log',jobs.log), result=p_job->'result', last_error=p_job->>'last_error',
    ended_at=NULLIF(p_job->>'ended_at','')::TIMESTAMPTZ,
    lock_owner=CASE WHEN p_job->>'status' IN ('running','cancelling') THEN jobs.lock_owner ELSE NULL END,
    lock_expires_at=CASE WHEN p_job->>'status' IN ('running','cancelling') THEN jobs.lock_expires_at ELSE NULL END, updated_at=NOW()
  WHERE jobs.id=p_job->>'id' AND jobs.lock_owner=p_lock_owner AND jobs.lock_expires_at>=NOW()
    AND jobs.status IN ('running','cancelling') AND p_job->>'status' IN ('running','cancelling','done','error','timed_out','cancelled');
  GET DIAGNOSTICS v_updated=ROW_COUNT; RETURN v_updated=1;
END $$;

REVOKE ALL ON FUNCTION claim_backtest_job(JSONB, INTEGER, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION heartbeat_backtest_job(TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_management_command_effect_result(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_claimed_backtest_job(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_expired_backtest_jobs(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION persist_claimed_backtest_job(JSONB, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION create_admin_user_audited(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION update_admin_user_audited(UUID, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION claim_backtest_job(JSONB, INTEGER, BOOLEAN) TO service_role;
    GRANT EXECUTE ON FUNCTION heartbeat_backtest_job(TEXT, TEXT, INTEGER) TO service_role;
    GRANT EXECUTE ON FUNCTION record_management_command_effect_result(TEXT, TEXT, JSONB) TO service_role;
    GRANT EXECUTE ON FUNCTION fail_claimed_backtest_job(TEXT, TEXT, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION reconcile_expired_backtest_jobs(INTEGER) TO service_role;
    GRANT EXECUTE ON FUNCTION persist_claimed_backtest_job(JSONB, TEXT) TO service_role;
  END IF;
END $$;

ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'handicap';
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'handicap';
DROP INDEX IF EXISTS learned_patterns_key_unique;
DROP INDEX IF EXISTS learned_patterns_backtest_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_market_key_unique
  ON learned_patterns(market, pattern_key, league);
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_backtest_market_key_unique
  ON learned_patterns_backtest(market, pattern_key, league);

-- Strategy laboratory fact model (migration 0020). Facts are append-only;
-- experiment run lifecycle rows are intentionally mutable.
CREATE TABLE IF NOT EXISTS strategy_lab_snapshot_sets (
  id UUID PRIMARY KEY, run_id UUID NOT NULL, match_id VARCHAR(20) NOT NULL, match_date VARCHAR(8) NOT NULL,
  checkpoint_type TEXT NOT NULL, checkpoint_at TIMESTAMPTZ NOT NULL, dataset_mode TEXT NOT NULL,
  status TEXT NOT NULL, previous_snapshot_set_id UUID REFERENCES strategy_lab_snapshot_sets(id),
  revision INTEGER NOT NULL, supersedes_snapshot_set_id UUID REFERENCES strategy_lab_snapshot_sets(id),
  source_cutoff_at TIMESTAMPTZ NOT NULL, content_hash TEXT NOT NULL, schema_version INTEGER NOT NULL,
  completeness JSONB NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_lab_snapshot_sets_match_date_check CHECK (match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date,'YYYYMMDD'),'YYYYMMDD')=match_date),
  CONSTRAINT strategy_lab_snapshot_sets_checkpoint_check CHECK (checkpoint_type IN ('T1215','T30','T03')),
  CONSTRAINT strategy_lab_snapshot_sets_dataset_mode_check CHECK (dataset_mode IN ('strict_asof','reconstructed')),
  CONSTRAINT strategy_lab_snapshot_sets_status_check CHECK (status IN ('ready','partial','insufficient','invalid','missing')),
  CONSTRAINT strategy_lab_snapshot_sets_completeness_check CHECK(status IN('ready','partial') OR (jsonb_typeof(completeness)='object' AND btrim(COALESCE(completeness->>'reasonCode',''))<>'')),
  CONSTRAINT strategy_lab_snapshot_sets_schema_version_check CHECK (schema_version > 0),
  CONSTRAINT strategy_lab_snapshot_sets_revision_check CHECK (revision>0),
  CONSTRAINT strategy_lab_snapshot_sets_hash_check CHECK (btrim(content_hash)<>''),
  CONSTRAINT strategy_lab_snapshot_sets_trace_check CHECK (btrim(trace_id)<>''),
  CONSTRAINT strategy_lab_snapshot_sets_cutoff_check CHECK (dataset_mode='reconstructed' OR source_cutoff_at<=checkpoint_at),
  CONSTRAINT strategy_lab_snapshot_sets_not_self_previous_check CHECK (previous_snapshot_set_id IS NULL OR previous_snapshot_set_id<>id),
  CONSTRAINT strategy_lab_snapshot_sets_not_self_supersedes_check CHECK (supersedes_snapshot_set_id IS NULL OR supersedes_snapshot_set_id<>id),
  CONSTRAINT strategy_lab_snapshot_sets_revision_unique UNIQUE(run_id,match_id,match_date,checkpoint_type,checkpoint_at,dataset_mode,schema_version,revision),
  CONSTRAINT strategy_lab_snapshot_sets_content_unique UNIQUE(run_id,match_id,match_date,checkpoint_type,checkpoint_at,dataset_mode,schema_version,content_hash)
);
CREATE TABLE IF NOT EXISTS strategy_lab_snapshot_items (
  snapshot_set_id UUID NOT NULL REFERENCES strategy_lab_snapshot_sets(id),
  odds_snapshot_id INTEGER NOT NULL REFERENCES odds_snapshots(id), role TEXT NOT NULL,
  company_id VARCHAR(20) NOT NULL, market_type TEXT NOT NULL, snapshot_type TEXT NOT NULL,
  source_observed_at TIMESTAMPTZ, collected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(snapshot_set_id,odds_snapshot_id,role),
  CONSTRAINT strategy_lab_snapshot_items_role_check CHECK(role='current'),
  CONSTRAINT strategy_lab_snapshot_items_company_check CHECK(btrim(company_id)<>''),
  CONSTRAINT strategy_lab_snapshot_items_market_check CHECK(btrim(market_type)<>''),
  CONSTRAINT strategy_lab_snapshot_items_snapshot_type_check CHECK(btrim(snapshot_type)<>'')
);
CREATE TABLE IF NOT EXISTS strategy_lab_experiment_runs (
  id UUID PRIMARY KEY, run_type TEXT NOT NULL, status TEXT NOT NULL, dataset_mode TEXT NOT NULL,
  start_date VARCHAR(8) NOT NULL, end_date VARCHAR(8) NOT NULL, dataset_cutoff_at TIMESTAMPTZ NOT NULL,
  strategy_versions JSONB NOT NULL, configuration JSONB NOT NULL, code_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, trace_id TEXT NOT NULL,
  error_summary TEXT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_lab_experiment_runs_type_check CHECK(run_type IN ('shadow','backtest','manual')),
  CONSTRAINT strategy_lab_experiment_runs_status_check CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
  CONSTRAINT strategy_lab_experiment_runs_dataset_mode_check CHECK(dataset_mode IN ('strict_asof','reconstructed')),
  CONSTRAINT strategy_lab_experiment_runs_start_date_check CHECK(start_date ~ '^[0-9]{8}$' AND to_char(to_date(start_date,'YYYYMMDD'),'YYYYMMDD')=start_date),
  CONSTRAINT strategy_lab_experiment_runs_end_date_check CHECK(end_date ~ '^[0-9]{8}$' AND to_char(to_date(end_date,'YYYYMMDD'),'YYYYMMDD')=end_date),
  CONSTRAINT strategy_lab_experiment_runs_range_check CHECK(start_date<=end_date),
  CONSTRAINT strategy_lab_experiment_runs_identity_check CHECK(btrim(code_version)<>'' AND btrim(idempotency_key)<>'' AND btrim(created_by)<>'' AND btrim(trace_id)<>''),
  CONSTRAINT strategy_lab_experiment_runs_time_check CHECK(
    updated_at>=created_at AND (started_at IS NULL OR started_at>=created_at)
    AND (finished_at IS NULL OR finished_at>=created_at)
    AND ((status='pending' AND started_at IS NULL AND finished_at IS NULL)
      OR (status='running' AND started_at IS NOT NULL AND finished_at IS NULL AND updated_at>=started_at)
      OR (status IN ('succeeded','failed') AND started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at>=started_at AND updated_at>=finished_at)
      OR (status='cancelled' AND finished_at IS NOT NULL AND (started_at IS NULL OR finished_at>=started_at) AND updated_at>=finished_at)))
);
DO $$ BEGIN
  ALTER TABLE strategy_lab_snapshot_sets ADD CONSTRAINT strategy_lab_snapshot_sets_run_fk FOREIGN KEY(run_id) REFERENCES strategy_lab_experiment_runs(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS strategy_lab_predictions (
  id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES strategy_lab_experiment_runs(id),
  match_id VARCHAR(20) NOT NULL, match_date VARCHAR(8) NOT NULL, checkpoint_type TEXT NOT NULL,
  snapshot_set_id UUID NOT NULL REFERENCES strategy_lab_snapshot_sets(id), requested_strategy TEXT NOT NULL,
  executed_strategy TEXT NOT NULL, strategy_version TEXT NOT NULL REFERENCES strategy_versions(version),
  decision_status TEXT NOT NULL, selection TEXT, locked_deterministic BOOLEAN NOT NULL,
  reason_code TEXT NOT NULL, branch_id TEXT NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL,
  decision_payload JSONB NOT NULL, fallback_reason TEXT, legacy_prediction_id INTEGER REFERENCES prediction_results(id),
  source TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, trace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_lab_predictions_match_date_check CHECK(match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date,'YYYYMMDD'),'YYYYMMDD')=match_date),
  CONSTRAINT strategy_lab_predictions_checkpoint_check CHECK(checkpoint_type IN ('T1215','T30','T03')),
  CONSTRAINT strategy_lab_predictions_requested_check CHECK(requested_strategy IN ('A','B','C','D')),
  CONSTRAINT strategy_lab_predictions_executed_check CHECK(executed_strategy IN ('A','B','C','D')),
  CONSTRAINT strategy_lab_predictions_identity_check CHECK((requested_strategy='C' AND executed_strategy IN ('C','A')) OR (requested_strategy<>'C' AND executed_strategy=requested_strategy)),
  CONSTRAINT strategy_lab_predictions_fallback_check CHECK((requested_strategy='C' AND executed_strategy='A' AND fallback_reason IS NOT NULL AND btrim(fallback_reason)<>'') OR (NOT(requested_strategy='C' AND executed_strategy='A') AND fallback_reason IS NULL)),
  CONSTRAINT strategy_lab_predictions_status_check CHECK(decision_status IN ('recommend','observe','reanalyze_required','insufficient_data')),
  CONSTRAINT strategy_lab_predictions_selection_check CHECK((decision_status='recommend' AND selection IS NOT NULL AND selection IN ('home','away')) OR (decision_status<>'recommend' AND selection IS NULL)),
  CONSTRAINT strategy_lab_predictions_source_check CHECK(source IN ('experiment','d_compat_shadow')),
  CONSTRAINT strategy_lab_predictions_required_text_check CHECK(btrim(strategy_version)<>'' AND btrim(reason_code)<>'' AND btrim(branch_id)<>'' AND btrim(input_hash)<>'' AND btrim(output_hash)<>'' AND btrim(idempotency_key)<>'' AND btrim(trace_id)<>''),
  CONSTRAINT strategy_lab_predictions_matrix_unique UNIQUE(run_id,match_id,match_date,checkpoint_type,requested_strategy)
);
CREATE TABLE IF NOT EXISTS strategy_lab_settlements (
  id UUID PRIMARY KEY, prediction_id UUID NOT NULL REFERENCES strategy_lab_predictions(id), revision INTEGER NOT NULL,
  match_result_id INTEGER NOT NULL REFERENCES match_results(id),
  actual_quote_snapshot_id INTEGER REFERENCES odds_snapshots(id), quote_basis TEXT NOT NULL, outcome TEXT NOT NULL,
  profit_units NUMERIC(12,6), is_counted BOOLEAN NOT NULL, settlement_basis TEXT NOT NULL,
  evidence JSONB NOT NULL, settled_at TIMESTAMPTZ NOT NULL, settled_by TEXT NOT NULL,
  supersedes UUID REFERENCES strategy_lab_settlements(id), trace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_lab_settlements_revision_check CHECK(revision>0),
  CONSTRAINT strategy_lab_settlements_quote_basis_check CHECK(quote_basis IN ('actual','theoretical')),
  CONSTRAINT strategy_lab_settlements_outcome_check CHECK(outcome IN ('win','half_win','push','half_loss','loss','unavailable')),
  CONSTRAINT strategy_lab_settlements_basis_pair_check CHECK(
    (quote_basis='actual' AND settlement_basis='actual_quote' AND actual_quote_snapshot_id IS NOT NULL
      AND jsonb_typeof(evidence)='object' AND NOT(evidence?'actualQuoteSnapshotId') AND NOT(evidence?'theoreticalQuote'))
    OR (quote_basis='theoretical' AND settlement_basis='theoretical_quote' AND jsonb_typeof(evidence)='object'
      AND actual_quote_snapshot_id IS NULL
      AND evidence?'theoreticalQuote' AND jsonb_typeof(evidence->'theoreticalQuote')='object' AND evidence->'theoreticalQuote'<>'{}'::jsonb
      AND NOT(evidence?'actualQuoteSnapshotId'))),
  CONSTRAINT strategy_lab_settlements_profit_check CHECK(
    (outcome='unavailable' AND profit_units IS NULL AND is_counted=FALSE)
    OR (outcome IN ('win','half_win') AND profit_units IS NOT NULL AND profit_units>0 AND is_counted=TRUE)
    OR (outcome='push' AND profit_units IS NOT NULL AND profit_units=0 AND is_counted=TRUE)
    OR (outcome IN ('half_loss','loss') AND profit_units IS NOT NULL AND profit_units<0 AND is_counted=TRUE)),
  CONSTRAINT strategy_lab_settlements_identity_check CHECK(btrim(settled_by)<>'' AND btrim(trace_id)<>''),
  CONSTRAINT strategy_lab_settlements_not_self_supersedes_check CHECK(supersedes IS NULL OR supersedes<>id),
  CONSTRAINT strategy_lab_settlements_revision_unique UNIQUE(prediction_id,revision)
);
CREATE TABLE IF NOT EXISTS strategy_lab_command_receipts (
  id UUID PRIMARY KEY, action TEXT NOT NULL, operation_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'audit_pending', result_type TEXT NOT NULL, result_id UUID NOT NULL,
  actor_id TEXT NOT NULL, request_id TEXT NOT NULL, audit_attempts INTEGER NOT NULL DEFAULT 0,
  last_audit_error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), audited_at TIMESTAMPTZ,
  CONSTRAINT strategy_lab_command_receipts_action_check CHECK(action IN('run.create','run.transition','snapshot.capture','prediction.execute','settlement.create')),
  CONSTRAINT strategy_lab_command_receipts_status_check CHECK(status IN('audit_pending','audited')),
  CONSTRAINT strategy_lab_command_receipts_result_type_check CHECK(result_type IN('strategy_lab_run','strategy_lab_snapshot','strategy_lab_prediction','strategy_lab_settlement')),
  CONSTRAINT strategy_lab_command_receipts_required_text_check CHECK(btrim(operation_key)<>'' AND btrim(payload_hash)<>'' AND btrim(result_type)<>'' AND btrim(actor_id)<>'' AND btrim(request_id)<>''),
  CONSTRAINT strategy_lab_command_receipts_audit_check CHECK(audit_attempts>=0 AND ((status='audit_pending' AND audited_at IS NULL) OR (status='audited' AND audited_at IS NOT NULL))),
  CONSTRAINT strategy_lab_command_receipts_action_key_unique UNIQUE(action,operation_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_lab_snapshot_sets_supersedes_unique ON strategy_lab_snapshot_sets(supersedes_snapshot_set_id) WHERE supersedes_snapshot_set_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS strategy_lab_settlements_supersedes_unique ON strategy_lab_settlements(supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX IF NOT EXISTS strategy_lab_snapshot_sets_match_checkpoint_idx ON strategy_lab_snapshot_sets(run_id,match_id,match_date,checkpoint_type,checkpoint_at);
CREATE INDEX IF NOT EXISTS strategy_lab_snapshot_items_set_market_idx ON strategy_lab_snapshot_items(snapshot_set_id,market_type,role);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_lab_snapshot_items_one_current_unique ON strategy_lab_snapshot_items(snapshot_set_id);
CREATE INDEX IF NOT EXISTS strategy_lab_experiment_runs_status_idx ON strategy_lab_experiment_runs(status,created_at);
CREATE INDEX IF NOT EXISTS strategy_lab_experiment_runs_date_idx ON strategy_lab_experiment_runs(start_date,end_date,dataset_mode);
CREATE INDEX IF NOT EXISTS strategy_lab_predictions_run_matrix_idx ON strategy_lab_predictions(run_id,checkpoint_type,requested_strategy,decision_status);
CREATE INDEX IF NOT EXISTS strategy_lab_predictions_match_idx ON strategy_lab_predictions(match_id,match_date,checkpoint_type);
CREATE INDEX IF NOT EXISTS strategy_lab_settlements_prediction_idx ON strategy_lab_settlements(prediction_id,revision DESC);
CREATE INDEX IF NOT EXISTS strategy_lab_settlements_result_idx ON strategy_lab_settlements(match_result_id,quote_basis,is_counted);
CREATE INDEX IF NOT EXISTS strategy_lab_settlements_actual_quote_idx ON strategy_lab_settlements(actual_quote_snapshot_id) WHERE actual_quote_snapshot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS strategy_lab_command_receipts_pending_idx ON strategy_lab_command_receipts(status,created_at) WHERE status='audit_pending';

CREATE OR REPLACE FUNCTION strategy_lab_reject_fact_mutation() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'strategy lab fact tables are append-only'; END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_snapshot_item_asof() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE snapshot_set strategy_lab_snapshot_sets%ROWTYPE; source_snapshot odds_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO snapshot_set FROM strategy_lab_snapshot_sets WHERE id=NEW.snapshot_set_id;
  SELECT * INTO source_snapshot FROM odds_snapshots WHERE id=NEW.odds_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'referenced odds snapshot is unavailable'; END IF;
  IF source_snapshot.match_id<>snapshot_set.match_id OR source_snapshot.match_date<>snapshot_set.match_date THEN RAISE EXCEPTION 'snapshot item match identity mismatch'; END IF;
  IF NEW.company_id<>source_snapshot.company_id OR NEW.market_type<>source_snapshot.market_type OR NEW.snapshot_type<>source_snapshot.snapshot_type
     OR NEW.source_observed_at IS DISTINCT FROM source_snapshot.source_observed_at OR NEW.collected_at IS DISTINCT FROM source_snapshot.collected_at THEN
    RAISE EXCEPTION 'snapshot item evidence mismatch';
  END IF;
  IF snapshot_set.dataset_mode='strict_asof' AND (NEW.source_observed_at IS NULL OR NEW.source_observed_at>snapshot_set.checkpoint_at OR NEW.collected_at>snapshot_set.checkpoint_at
     OR source_snapshot.hash_version<>'canonical-json-v2' OR source_snapshot.canonical_content_hash IS NULL OR source_snapshot.content_hash<>source_snapshot.canonical_content_hash) THEN
    RAISE EXCEPTION 'strict_asof evidence contract rejected';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_snapshot_item_completeness() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE target_id UUID; snapshot_status TEXT; item_count BIGINT;
BEGIN
  IF TG_TABLE_NAME='strategy_lab_snapshot_sets' THEN
    target_id:=NEW.id;
  ELSE
    target_id:=NEW.snapshot_set_id;
  END IF;
  SELECT status INTO snapshot_status FROM strategy_lab_snapshot_sets WHERE id=target_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot set is unavailable'; END IF;
  SELECT count(*) INTO item_count FROM strategy_lab_snapshot_items WHERE snapshot_set_id=target_id;
  IF snapshot_status IN('ready','partial') AND item_count<>1 THEN RAISE EXCEPTION 'ready or partial snapshot requires exactly one current item'; END IF;
  IF snapshot_status IN('missing','insufficient','invalid') AND item_count<>0 THEN RAISE EXCEPTION 'snapshot status forbids evidence items'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION odds_snapshots_reject_mutation() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'odds snapshots are append-only'; END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_snapshot_set_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE previous_set strategy_lab_snapshot_sets%ROWTYPE; superseded_set strategy_lab_snapshot_sets%ROWTYPE;
BEGIN
  IF NEW.checkpoint_type='T1215' THEN
    IF NEW.previous_snapshot_set_id IS NOT NULL THEN RAISE EXCEPTION 'T1215 cannot have previous checkpoint'; END IF;
  ELSE
    IF NEW.previous_snapshot_set_id IS NULL THEN RAISE EXCEPTION 'checkpoint predecessor is required'; END IF;
    SELECT * INTO previous_set FROM strategy_lab_snapshot_sets WHERE id=NEW.previous_snapshot_set_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'checkpoint predecessor is unavailable'; END IF;
    IF previous_set.run_id<>NEW.run_id OR previous_set.match_id<>NEW.match_id OR previous_set.match_date<>NEW.match_date OR previous_set.dataset_mode<>NEW.dataset_mode OR previous_set.checkpoint_at>=NEW.checkpoint_at THEN RAISE EXCEPTION 'invalid checkpoint predecessor identity or ordering'; END IF;
    IF (NEW.checkpoint_type='T30' AND previous_set.checkpoint_type<>'T1215') OR (NEW.checkpoint_type='T03' AND previous_set.checkpoint_type<>'T30') THEN RAISE EXCEPTION 'invalid checkpoint predecessor type'; END IF;
  END IF;
  IF NEW.revision=1 THEN
    IF NEW.supersedes_snapshot_set_id IS NOT NULL THEN RAISE EXCEPTION 'first snapshot revision cannot supersede'; END IF;
  ELSE
    IF NEW.supersedes_snapshot_set_id IS NULL THEN RAISE EXCEPTION 'snapshot revision predecessor is required'; END IF;
    SELECT * INTO superseded_set FROM strategy_lab_snapshot_sets WHERE id=NEW.supersedes_snapshot_set_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'snapshot revision predecessor is unavailable'; END IF;
    IF superseded_set.run_id<>NEW.run_id OR superseded_set.match_id<>NEW.match_id OR superseded_set.match_date<>NEW.match_date OR superseded_set.checkpoint_type<>NEW.checkpoint_type OR superseded_set.checkpoint_at<>NEW.checkpoint_at OR superseded_set.dataset_mode<>NEW.dataset_mode OR superseded_set.schema_version<>NEW.schema_version OR superseded_set.revision<>NEW.revision-1 THEN RAISE EXCEPTION 'invalid snapshot revision chain'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_prediction_snapshot() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE snapshot_set strategy_lab_snapshot_sets%ROWTYPE;
BEGIN SELECT * INTO snapshot_set FROM strategy_lab_snapshot_sets WHERE id=NEW.snapshot_set_id;
  IF NOT FOUND OR snapshot_set.run_id<>NEW.run_id OR snapshot_set.match_id<>NEW.match_id OR snapshot_set.match_date<>NEW.match_date OR snapshot_set.checkpoint_type<>NEW.checkpoint_type THEN RAISE EXCEPTION 'prediction snapshot identity mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_settlement_revision() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE superseded_settlement strategy_lab_settlements%ROWTYPE;
BEGIN
  IF NEW.revision=1 THEN
    IF NEW.supersedes IS NOT NULL THEN RAISE EXCEPTION 'first settlement revision cannot supersede'; END IF;
  ELSE
    IF NEW.supersedes IS NULL THEN RAISE EXCEPTION 'settlement revision predecessor is required'; END IF;
    SELECT * INTO superseded_settlement FROM strategy_lab_settlements WHERE id=NEW.supersedes;
    IF NOT FOUND OR superseded_settlement.prediction_id<>NEW.prediction_id OR superseded_settlement.revision<>NEW.revision-1 THEN RAISE EXCEPTION 'invalid settlement revision chain'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_settlement_evidence() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE prediction strategy_lab_predictions%ROWTYPE; result match_results%ROWTYPE; actual_quote odds_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO prediction FROM strategy_lab_predictions WHERE id=NEW.prediction_id;
  SELECT * INTO result FROM match_results WHERE id=NEW.match_result_id;
  IF prediction.match_id<>result.match_id OR prediction.match_date<>result.match_date THEN RAISE EXCEPTION 'settlement match result identity mismatch'; END IF;
  IF NEW.quote_basis='actual' THEN
    SELECT * INTO actual_quote FROM odds_snapshots WHERE id=NEW.actual_quote_snapshot_id;
    IF actual_quote.match_id<>prediction.match_id OR actual_quote.match_date<>prediction.match_date THEN RAISE EXCEPTION 'actual quote snapshot identity mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_run_transition() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_type IS DISTINCT FROM OLD.run_type OR NEW.dataset_mode IS DISTINCT FROM OLD.dataset_mode OR NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date OR NEW.dataset_cutoff_at IS DISTINCT FROM OLD.dataset_cutoff_at OR NEW.strategy_versions IS DISTINCT FROM OLD.strategy_versions OR NEW.configuration IS DISTINCT FROM OLD.configuration OR NEW.code_version IS DISTINCT FROM OLD.code_version OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.trace_id IS DISTINCT FROM OLD.trace_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'experiment run immutable fields cannot change'; END IF;
  IF NOT((OLD.status='pending' AND NEW.status IN('running','cancelled')) OR (OLD.status='running' AND NEW.status IN('succeeded','failed','cancelled'))) THEN RAISE EXCEPTION 'invalid experiment run transition'; END IF;
  IF OLD.status='running' AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN RAISE EXCEPTION 'experiment run started_at is immutable after start'; END IF;
  IF NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'experiment run updated_at cannot move backwards'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_run_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.status<>'pending' OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL OR NEW.updated_at<NEW.created_at THEN RAISE EXCEPTION 'experiment run must start pending'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_receipt_transition() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.action IS DISTINCT FROM OLD.action OR NEW.operation_key IS DISTINCT FROM OLD.operation_key OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR NEW.result_type IS DISTINCT FROM OLD.result_type OR NEW.result_id IS DISTINCT FROM OLD.result_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'command receipt immutable fields cannot change'; END IF;
  IF OLD.status<>'audit_pending' OR NEW.audit_attempts<>OLD.audit_attempts+1 OR NEW.updated_at<OLD.updated_at OR (NEW.status='audit_pending' AND (NEW.audited_at IS NOT NULL OR btrim(COALESCE(NEW.last_audit_error_code,''))='')) OR (NEW.status='audited' AND (NEW.audited_at IS NULL OR NEW.last_audit_error_code IS NOT NULL)) OR NEW.status NOT IN('audit_pending','audited') THEN RAISE EXCEPTION 'invalid command receipt transition'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS strategy_lab_snapshot_sets_append_only ON strategy_lab_snapshot_sets;
DROP TRIGGER IF EXISTS strategy_lab_snapshot_items_append_only ON strategy_lab_snapshot_items;
DROP TRIGGER IF EXISTS strategy_lab_predictions_append_only ON strategy_lab_predictions;
DROP TRIGGER IF EXISTS strategy_lab_settlements_append_only ON strategy_lab_settlements;
DROP TRIGGER IF EXISTS strategy_lab_snapshot_items_asof ON strategy_lab_snapshot_items;
DROP TRIGGER IF EXISTS strategy_lab_snapshot_sets_require_items ON strategy_lab_snapshot_sets;
DROP TRIGGER IF EXISTS strategy_lab_snapshot_items_require_valid_set ON strategy_lab_snapshot_items;
DROP TRIGGER IF EXISTS strategy_lab_snapshot_sets_validate_insert ON strategy_lab_snapshot_sets;
DROP TRIGGER IF EXISTS strategy_lab_predictions_validate_snapshot ON strategy_lab_predictions;
DROP TRIGGER IF EXISTS strategy_lab_settlements_validate_revision ON strategy_lab_settlements;
DROP TRIGGER IF EXISTS strategy_lab_settlements_validate_evidence ON strategy_lab_settlements;
DROP TRIGGER IF EXISTS strategy_lab_experiment_runs_validate_transition ON strategy_lab_experiment_runs;
DROP TRIGGER IF EXISTS strategy_lab_experiment_runs_validate_insert ON strategy_lab_experiment_runs;
DROP TRIGGER IF EXISTS strategy_lab_command_receipts_validate_transition ON strategy_lab_command_receipts;
DROP TRIGGER IF EXISTS odds_snapshots_append_only ON odds_snapshots;
CREATE TRIGGER strategy_lab_snapshot_sets_append_only BEFORE UPDATE OR DELETE ON strategy_lab_snapshot_sets FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation();
CREATE TRIGGER strategy_lab_snapshot_items_append_only BEFORE UPDATE OR DELETE ON strategy_lab_snapshot_items FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation();
CREATE TRIGGER strategy_lab_predictions_append_only BEFORE UPDATE OR DELETE ON strategy_lab_predictions FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation();
CREATE TRIGGER strategy_lab_settlements_append_only BEFORE UPDATE OR DELETE ON strategy_lab_settlements FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation();
CREATE TRIGGER strategy_lab_snapshot_items_asof BEFORE INSERT ON strategy_lab_snapshot_items FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_snapshot_item_asof();
CREATE CONSTRAINT TRIGGER strategy_lab_snapshot_sets_require_items AFTER INSERT ON strategy_lab_snapshot_sets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_snapshot_item_completeness();
CREATE CONSTRAINT TRIGGER strategy_lab_snapshot_items_require_valid_set AFTER INSERT ON strategy_lab_snapshot_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_snapshot_item_completeness();
CREATE TRIGGER strategy_lab_snapshot_sets_validate_insert BEFORE INSERT ON strategy_lab_snapshot_sets FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_snapshot_set_insert();
CREATE TRIGGER strategy_lab_predictions_validate_snapshot BEFORE INSERT ON strategy_lab_predictions FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_prediction_snapshot();
CREATE TRIGGER strategy_lab_settlements_validate_revision BEFORE INSERT ON strategy_lab_settlements FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_settlement_revision();
CREATE TRIGGER strategy_lab_settlements_validate_evidence BEFORE INSERT ON strategy_lab_settlements FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_settlement_evidence();
CREATE TRIGGER strategy_lab_experiment_runs_validate_transition BEFORE UPDATE ON strategy_lab_experiment_runs FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_run_transition();
CREATE TRIGGER strategy_lab_experiment_runs_validate_insert BEFORE INSERT ON strategy_lab_experiment_runs FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_run_insert();
CREATE TRIGGER strategy_lab_command_receipts_validate_transition BEFORE UPDATE ON strategy_lab_command_receipts FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_receipt_transition();
CREATE TRIGGER odds_snapshots_append_only BEFORE UPDATE OR DELETE ON odds_snapshots FOR EACH ROW EXECUTE FUNCTION odds_snapshots_reject_mutation();
ALTER TABLE strategy_lab_snapshot_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_snapshot_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_experiment_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_lab_command_receipts ENABLE ROW LEVEL SECURITY;

-- Strategy Lab Phase 2: temporal policy, match facts, immutable artifacts, and trusted builds.
CREATE OR REPLACE FUNCTION strategy_lab_canonicalize_text(value TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,public AS $$
  SELECT regexp_replace(regexp_replace(normalize(translate(value, U&'\0009\000D\000A\00A0\202F\3000', '      '), NFC), ' +', ' ', 'g'), '^ +| +$', '', 'g')
$$;

CREATE TABLE IF NOT EXISTS strategy_lab_match_facts (
 id UUID PRIMARY KEY, match_id VARCHAR(20) NOT NULL, match_date VARCHAR(8) NOT NULL, league_name_raw TEXT NOT NULL, league_name_normalized TEXT NOT NULL, kickoff_at TIMESTAMPTZ NOT NULL,
 source TEXT NOT NULL, source_observed_at TIMESTAMPTZ NOT NULL, dataset_cutoff_at TIMESTAMPTZ NOT NULL, canonical_payload JSONB NOT NULL, content_hash TEXT NOT NULL, revision INTEGER NOT NULL,
 supersedes_id UUID REFERENCES strategy_lab_match_facts(id), schema_version INTEGER NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_match_facts_date_check CHECK(match_date~'^[0-9]{8}$' AND to_char(to_date(match_date,'YYYYMMDD'),'YYYYMMDD')=match_date),
 CONSTRAINT strategy_lab_match_facts_canonical_check CHECK(league_name_normalized=strategy_lab_canonicalize_text(league_name_raw) AND league_name_normalized<>''),
 CONSTRAINT strategy_lab_match_facts_time_check CHECK(source_observed_at<=dataset_cutoff_at), CONSTRAINT strategy_lab_match_facts_hash_check CHECK(content_hash~'^[0-9a-f]{64}$'),
 CONSTRAINT strategy_lab_match_facts_revision_check CHECK(revision>0 AND schema_version>0), UNIQUE(match_id,match_date,source,schema_version,revision), UNIQUE(match_id,match_date,source,schema_version,content_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_lab_match_facts_supersedes_unique ON strategy_lab_match_facts(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS strategy_lab_match_facts_asof_idx ON strategy_lab_match_facts(match_id,match_date,source_observed_at DESC,revision DESC);

CREATE TABLE IF NOT EXISTS strategy_lab_focused_league_baselines (
 id UUID PRIMARY KEY, source TEXT NOT NULL, source_observed_at TIMESTAMPTZ NOT NULL, dataset_cutoff_at TIMESTAMPTZ NOT NULL, canonical_payload JSONB NOT NULL, content_hash TEXT NOT NULL UNIQUE,
 member_count INTEGER NOT NULL, is_complete BOOLEAN NOT NULL, completed_at TIMESTAMPTZ, actor TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_focused_baseline_complete_check CHECK(is_complete AND completed_at=source_observed_at), CONSTRAINT strategy_lab_focused_baseline_time_check CHECK(source_observed_at<=dataset_cutoff_at),
 CONSTRAINT strategy_lab_focused_baseline_hash_check CHECK(content_hash~'^[0-9a-f]{64}$'), CONSTRAINT strategy_lab_focused_baseline_count_check CHECK(member_count>0)
);
CREATE TABLE IF NOT EXISTS strategy_lab_focused_league_events (
 id UUID PRIMARY KEY, baseline_id UUID NOT NULL REFERENCES strategy_lab_focused_league_baselines(id), source TEXT NOT NULL, league_name_raw TEXT NOT NULL, league_name_normalized TEXT NOT NULL,
 action TEXT NOT NULL, source_observed_at TIMESTAMPTZ NOT NULL, dataset_cutoff_at TIMESTAMPTZ NOT NULL, canonical_payload JSONB NOT NULL, content_hash TEXT NOT NULL, revision INTEGER NOT NULL,
 supersedes_id UUID REFERENCES strategy_lab_focused_league_events(id), actor TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_focused_event_action_check CHECK(action IN('add','remove')), CONSTRAINT strategy_lab_focused_event_canonical_check CHECK(league_name_normalized=strategy_lab_canonicalize_text(league_name_raw) AND league_name_normalized<>''),
 CONSTRAINT strategy_lab_focused_event_time_check CHECK(source_observed_at<=dataset_cutoff_at), CONSTRAINT strategy_lab_focused_event_hash_check CHECK(content_hash~'^[0-9a-f]{64}$'),
 CONSTRAINT strategy_lab_focused_event_revision_check CHECK(revision>0), UNIQUE(baseline_id,source,league_name_normalized,revision), UNIQUE(content_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_lab_focused_event_supersedes_unique ON strategy_lab_focused_league_events(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS strategy_lab_focused_event_asof_idx ON strategy_lab_focused_league_events(source_observed_at,revision);

CREATE TABLE IF NOT EXISTS strategy_lab_league_policy_artifacts (
 content_hash TEXT PRIMARY KEY, version_hash TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, leagues JSONB NOT NULL, canonical_payload JSONB NOT NULL, source_row_count INTEGER NOT NULL,
 schema_version INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT strategy_lab_policy_artifact_mode_check CHECK(mode='user_focused_leagues'),
 CONSTRAINT strategy_lab_policy_artifact_hash_check CHECK(content_hash~'^[0-9a-f]{64}$' AND version_hash=content_hash), CONSTRAINT strategy_lab_policy_artifact_count_check CHECK(source_row_count=jsonb_array_length(leagues) AND source_row_count>0 AND schema_version>0)
);
CREATE TABLE IF NOT EXISTS strategy_lab_league_policy_captures (
 id UUID PRIMARY KEY, artifact_hash TEXT NOT NULL REFERENCES strategy_lab_league_policy_artifacts(content_hash), dataset_cutoff_at TIMESTAMPTZ NOT NULL, captured_at TIMESTAMPTZ NOT NULL,
 source_history_cutoff TIMESTAMPTZ NOT NULL, evidence_hash TEXT NOT NULL, created_by TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_policy_capture_time_check CHECK(source_history_cutoff=dataset_cutoff_at AND dataset_cutoff_at<=captured_at), CONSTRAINT strategy_lab_policy_capture_hash_check CHECK(evidence_hash~'^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS strategy_lab_policy_capture_asof_idx ON strategy_lab_league_policy_captures(artifact_hash,dataset_cutoff_at,captured_at);

CREATE TABLE IF NOT EXISTS strategy_lab_strategy_artifacts (
 strategy_id TEXT NOT NULL, version TEXT NOT NULL, artifact_hash TEXT PRIMARY KEY, engine_version TEXT NOT NULL, definition JSONB NOT NULL, canonical_payload JSONB NOT NULL,
 code_compatibility TEXT NOT NULL, schema_version INTEGER NOT NULL, behavior_corpus_hash TEXT NOT NULL, executable BOOLEAN NOT NULL, created_by TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_strategy_artifact_id_check CHECK(strategy_id IN('A','B','C','D')), CONSTRAINT strategy_lab_strategy_artifact_hash_check CHECK(artifact_hash~'^[0-9a-f]{64}$' AND behavior_corpus_hash~'^[0-9a-f]{64}$'),
 CONSTRAINT strategy_lab_strategy_artifact_definition_check CHECK(jsonb_typeof(definition)='object' AND definition<>'{}'::jsonb AND schema_version>0), CONSTRAINT strategy_lab_strategy_d_check CHECK(strategy_id<>'D' OR executable=FALSE), UNIQUE(strategy_id,version)
);
CREATE TABLE IF NOT EXISTS strategy_lab_strategy_publications (
 id UUID PRIMARY KEY, root_id UUID NOT NULL, artifact_hash TEXT NOT NULL REFERENCES strategy_lab_strategy_artifacts(artifact_hash), status TEXT NOT NULL, effective_from TIMESTAMPTZ NOT NULL,
 effective_to TIMESTAMPTZ, revision INTEGER NOT NULL, supersedes_id UUID REFERENCES strategy_lab_strategy_publications(id), published_at TIMESTAMPTZ NOT NULL, retired_at TIMESTAMPTZ,
 actor TEXT NOT NULL, trace_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT strategy_lab_publication_status_check CHECK(status IN('published','retired')),
 CONSTRAINT strategy_lab_publication_interval_check CHECK(effective_to IS NULL OR effective_to>effective_from), CONSTRAINT strategy_lab_publication_lifecycle_check CHECK((status='published' AND retired_at IS NULL) OR (status='retired' AND retired_at IS NOT NULL AND effective_to=retired_at)),
 CONSTRAINT strategy_lab_publication_revision_check CHECK(revision>0), UNIQUE(root_id,revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_lab_publication_supersedes_unique ON strategy_lab_strategy_publications(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS strategy_lab_build_artifacts (
 build_id TEXT PRIMARY KEY, manifest_digest TEXT NOT NULL, commit_sha TEXT NOT NULL, release_id TEXT NOT NULL, artifact_digest TEXT NOT NULL, compatibility TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT strategy_lab_build_id_check CHECK(build_id~'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'), CONSTRAINT strategy_lab_build_identity_check CHECK(manifest_digest~'^[0-9a-f]{64}$' AND commit_sha~'^[0-9a-f]{40}$' AND release_id~'^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$' AND artifact_digest~'^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION strategy_lab_validate_match_fact_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE prior strategy_lab_match_facts%ROWTYPE; BEGIN
 IF NEW.canonical_payload<>jsonb_build_object('schemaVersion',NEW.schema_version,'matchId',NEW.match_id,'matchDate',NEW.match_date,'league',NEW.league_name_normalized,'kickoffAt',NEW.kickoff_at,'source',NEW.source,'sourceObservedAt',NEW.source_observed_at,'datasetCutoffAt',NEW.dataset_cutoff_at,'revision',NEW.revision) THEN RAISE EXCEPTION 'invalid match canonical payload'; END IF;
 IF NEW.revision=1 THEN IF NEW.supersedes_id IS NOT NULL THEN RAISE EXCEPTION 'first revision supersedes'; END IF; ELSE SELECT * INTO prior FROM strategy_lab_match_facts WHERE id=NEW.supersedes_id FOR KEY SHARE; IF NOT FOUND OR prior.match_id<>NEW.match_id OR prior.match_date<>NEW.match_date OR prior.source<>NEW.source OR prior.schema_version<>NEW.schema_version OR prior.revision<>NEW.revision-1 OR NEW.source_observed_at<prior.source_observed_at OR NEW.dataset_cutoff_at<prior.dataset_cutoff_at THEN RAISE EXCEPTION 'invalid match revision chain'; END IF; END IF; RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_focused_baseline_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE item TEXT; previous BYTEA; current_bytes BYTEA; n INTEGER:=0; BEGIN
 IF jsonb_typeof(NEW.canonical_payload->'leagues')<>'array' OR NEW.canonical_payload<>jsonb_build_object('schemaVersion',1,'baselineId',NEW.id,'source',NEW.source,'sourceObservedAt',NEW.source_observed_at,'leagues',NEW.canonical_payload->'leagues') THEN RAISE EXCEPTION 'invalid baseline canonical payload'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements_text(NEW.canonical_payload->'leagues') AS entry(value) LOOP current_bytes:=convert_to(item,'UTF8'); IF item='' OR item<>public.strategy_lab_canonicalize_text(item) OR (previous IS NOT NULL AND previous>=current_bytes) THEN RAISE EXCEPTION 'noncanonical baseline member'; END IF; previous:=current_bytes;n:=n+1; END LOOP;
 IF n<>NEW.member_count OR n=0 THEN RAISE EXCEPTION 'baseline member count mismatch'; END IF; RETURN NEW; EXCEPTION WHEN data_exception THEN RAISE EXCEPTION 'baseline members must be strings'; END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_focused_baseline_complete() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE baseline strategy_lab_focused_league_baselines%ROWTYPE; baseline_key UUID; actual_count INTEGER; BEGIN
 IF TG_TABLE_NAME='strategy_lab_focused_league_baselines' THEN baseline_key:=NEW.id; ELSE baseline_key:=NEW.baseline_id; END IF;
 SELECT * INTO baseline FROM strategy_lab_focused_league_baselines WHERE id=baseline_key; IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT COUNT(*) INTO actual_count FROM strategy_lab_focused_league_events e WHERE e.baseline_id=baseline.id AND e.source=baseline.source AND e.revision=1 AND e.action='add' AND e.source_observed_at=baseline.source_observed_at AND e.dataset_cutoff_at=baseline.dataset_cutoff_at;
 IF actual_count<>baseline.member_count OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(baseline.canonical_payload->'leagues') member WHERE NOT EXISTS(SELECT 1 FROM strategy_lab_focused_league_events e WHERE e.baseline_id=baseline.id AND e.source=baseline.source AND e.league_name_normalized=member AND e.revision=1 AND e.action='add' AND e.source_observed_at=baseline.source_observed_at AND e.dataset_cutoff_at=baseline.dataset_cutoff_at)) THEN RAISE EXCEPTION 'incomplete focused league baseline'; END IF; RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_focused_event_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE prior strategy_lab_focused_league_events%ROWTYPE; BEGIN
 IF NEW.canonical_payload<>jsonb_build_object('schemaVersion',1,'baselineId',NEW.baseline_id,'source',NEW.source,'league',NEW.league_name_normalized,'action',NEW.action,'sourceObservedAt',NEW.source_observed_at,'datasetCutoffAt',NEW.dataset_cutoff_at,'revision',NEW.revision) THEN RAISE EXCEPTION 'invalid focused event payload'; END IF;
 IF NEW.revision=1 THEN IF NEW.supersedes_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM strategy_lab_focused_league_baselines b WHERE b.id=NEW.baseline_id AND b.source=NEW.source AND b.is_complete AND b.source_observed_at=NEW.source_observed_at AND NEW.action='add') THEN RAISE EXCEPTION 'invalid baseline event'; END IF; ELSE SELECT * INTO prior FROM strategy_lab_focused_league_events WHERE id=NEW.supersedes_id FOR KEY SHARE; IF NOT FOUND OR prior.source<>NEW.source OR prior.league_name_normalized<>NEW.league_name_normalized OR prior.revision<>NEW.revision-1 OR NEW.source_observed_at<prior.source_observed_at OR NEW.dataset_cutoff_at<prior.dataset_cutoff_at THEN RAISE EXCEPTION 'invalid focused event chain'; END IF; END IF; RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_policy_artifact() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE item TEXT; previous TEXT; n INTEGER:=0; BEGIN
 IF jsonb_typeof(NEW.leagues)<>'array' OR jsonb_array_length(NEW.leagues)=0 THEN RAISE EXCEPTION 'empty policy'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements_text(NEW.leagues) AS entry(value) LOOP IF item<>public.strategy_lab_canonicalize_text(item) OR item='' OR (previous IS NOT NULL AND convert_to(previous,'UTF8')>=convert_to(item,'UTF8')) THEN RAISE EXCEPTION 'noncanonical policy'; END IF; previous:=item;n:=n+1; END LOOP;
 IF NEW.canonical_payload<>jsonb_build_object('schemaVersion',NEW.schema_version,'mode',NEW.mode,'leagues',NEW.leagues) THEN RAISE EXCEPTION 'invalid policy payload'; END IF; RETURN NEW; EXCEPTION WHEN data_exception THEN RAISE EXCEPTION 'policy entries must be strings'; END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_strategy_artifact() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.schema_version<>1 OR NEW.canonical_payload<>jsonb_build_object('schemaVersion',NEW.schema_version,'engineVersion',NEW.engine_version,'codeCompatibility',NEW.code_compatibility,'behaviorCorpusHash',NEW.behavior_corpus_hash,'definition',NEW.definition) OR NEW.definition->>'strategyId'<>NEW.strategy_id OR NEW.definition->>'version'<>NEW.version OR (NEW.definition->>'executable')::BOOLEAN<>NEW.executable THEN RAISE EXCEPTION 'invalid strategy payload'; END IF;
 IF (NEW.strategy_id IN('A','B') AND NEW.definition<>jsonb_build_object('strategyId',NEW.strategy_id,'version',NEW.version,'executable',TRUE,'deterministic',TRUE)) OR (NEW.strategy_id='C' AND NEW.definition<>jsonb_build_object('strategyId','C','version',NEW.version,'executable',TRUE,'fallback','A','completeWithoutExecutor','unavailable')) OR (NEW.strategy_id='D' AND NEW.definition<>jsonb_build_object('strategyId','D','version',NEW.version,'executable',FALSE,'availability','compatibility-only')) THEN RAISE EXCEPTION 'invalid strategy definition'; END IF; RETURN NEW; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid strategy definition'; END $$;
CREATE OR REPLACE FUNCTION strategy_lab_validate_publication_insert() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE prior strategy_lab_strategy_publications%ROWTYPE; sid TEXT; BEGIN
 IF NEW.status='retired' AND (NEW.effective_to IS NULL OR NEW.effective_to<=NEW.effective_from OR NEW.retired_at<>NEW.effective_to) THEN RAISE EXCEPTION 'invalid retirement'; END IF;
 IF NEW.revision=1 THEN IF NEW.supersedes_id IS NOT NULL OR NEW.root_id<>NEW.id THEN RAISE EXCEPTION 'first publication identity'; END IF; ELSE SELECT * INTO prior FROM strategy_lab_strategy_publications WHERE id=NEW.supersedes_id FOR KEY SHARE; IF NOT FOUND OR prior.root_id<>NEW.root_id OR prior.artifact_hash<>NEW.artifact_hash OR prior.revision<>NEW.revision-1 OR NEW.published_at<prior.published_at OR NEW.effective_from<>prior.effective_from THEN RAISE EXCEPTION 'invalid publication chain'; END IF; END IF;
 SELECT strategy_id INTO sid FROM strategy_lab_strategy_artifacts WHERE artifact_hash=NEW.artifact_hash;
 IF EXISTS(SELECT 1 FROM strategy_lab_strategy_publications p JOIN strategy_lab_strategy_artifacts a ON a.artifact_hash=p.artifact_hash WHERE a.strategy_id=sid AND p.root_id<>NEW.root_id AND p.status='published' AND NOT EXISTS(SELECT 1 FROM strategy_lab_strategy_publications newer WHERE newer.root_id=p.root_id AND newer.revision>p.revision) AND tstzrange(p.effective_from,p.effective_to,'[)')&&tstzrange(NEW.effective_from,NEW.effective_to,'[)')) THEN RAISE EXCEPTION 'publication intervals overlap'; END IF; RETURN NEW; END $$;

DROP TRIGGER IF EXISTS strategy_lab_match_validate ON strategy_lab_match_facts;
DROP TRIGGER IF EXISTS strategy_lab_focused_baseline_validate ON strategy_lab_focused_league_baselines;
DROP TRIGGER IF EXISTS strategy_lab_focused_validate ON strategy_lab_focused_league_events;
DROP TRIGGER IF EXISTS strategy_lab_policy_validate ON strategy_lab_league_policy_artifacts;
DROP TRIGGER IF EXISTS strategy_lab_artifact_validate ON strategy_lab_strategy_artifacts;
DROP TRIGGER IF EXISTS strategy_lab_publication_validate ON strategy_lab_strategy_publications;
DROP TRIGGER IF EXISTS strategy_lab_focused_baseline_complete ON strategy_lab_focused_league_baselines;
DROP TRIGGER IF EXISTS strategy_lab_focused_event_complete ON strategy_lab_focused_league_events;
CREATE TRIGGER strategy_lab_match_validate BEFORE INSERT ON strategy_lab_match_facts FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_match_fact_insert();
CREATE TRIGGER strategy_lab_focused_baseline_validate BEFORE INSERT ON strategy_lab_focused_league_baselines FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_focused_baseline_insert();
CREATE TRIGGER strategy_lab_focused_validate BEFORE INSERT ON strategy_lab_focused_league_events FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_focused_event_insert();
CREATE TRIGGER strategy_lab_policy_validate BEFORE INSERT ON strategy_lab_league_policy_artifacts FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_policy_artifact();
CREATE TRIGGER strategy_lab_artifact_validate BEFORE INSERT ON strategy_lab_strategy_artifacts FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_strategy_artifact();
CREATE TRIGGER strategy_lab_publication_validate BEFORE INSERT ON strategy_lab_strategy_publications FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_publication_insert();
CREATE CONSTRAINT TRIGGER strategy_lab_focused_baseline_complete AFTER INSERT ON strategy_lab_focused_league_baselines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_focused_baseline_complete();
CREATE CONSTRAINT TRIGGER strategy_lab_focused_event_complete AFTER INSERT ON strategy_lab_focused_league_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION strategy_lab_validate_focused_baseline_complete();
DO $$ DECLARE table_name TEXT; role_name TEXT; BEGIN
 FOREACH table_name IN ARRAY ARRAY['strategy_lab_snapshot_sets','strategy_lab_snapshot_items','strategy_lab_experiment_runs','strategy_lab_predictions','strategy_lab_settlements','strategy_lab_command_receipts','strategy_lab_match_facts','strategy_lab_focused_league_baselines','strategy_lab_focused_league_events','strategy_lab_league_policy_artifacts','strategy_lab_league_policy_captures','strategy_lab_strategy_artifacts','strategy_lab_strategy_publications','strategy_lab_build_artifacts'] LOOP
  IF table_name IN('strategy_lab_match_facts','strategy_lab_focused_league_baselines','strategy_lab_focused_league_events','strategy_lab_league_policy_artifacts','strategy_lab_league_policy_captures','strategy_lab_strategy_artifacts','strategy_lab_strategy_publications','strategy_lab_build_artifacts') THEN EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only ON %I',table_name,table_name); EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION strategy_lab_reject_fact_mutation()',table_name,table_name); END IF;
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name); EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',table_name);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name); END IF; END LOOP;
 END LOOP;
END $$;
DO $$ DECLARE function_signature TEXT; role_name TEXT; BEGIN
  FOREACH function_signature IN ARRAY ARRAY['strategy_lab_reject_fact_mutation()','strategy_lab_validate_snapshot_item_asof()','strategy_lab_validate_snapshot_item_completeness()','strategy_lab_validate_snapshot_set_insert()','strategy_lab_validate_prediction_snapshot()','strategy_lab_validate_receipt_transition()','strategy_lab_validate_settlement_revision()','strategy_lab_validate_settlement_evidence()','strategy_lab_validate_run_transition()','strategy_lab_validate_run_insert()','strategy_lab_canonicalize_text(text)','strategy_lab_validate_match_fact_insert()','strategy_lab_validate_focused_baseline_insert()','strategy_lab_validate_focused_baseline_complete()','strategy_lab_validate_focused_event_insert()','strategy_lab_validate_policy_artifact()','strategy_lab_validate_strategy_artifact()','strategy_lab_validate_publication_insert()','odds_snapshots_reject_mutation()'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',function_signature);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',function_signature,role_name); END IF; END LOOP;
 END LOOP;
END $$;

INSERT INTO schema_migrations(version, description)
VALUES ('0001_canonical_baseline', 'Canonical schema baseline for fresh installations')
ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations(version, description) VALUES
  ('0015_admin_lifecycle_strong_audit', 'Atomically audit administrator lifecycle mutations'),
  ('0016_atomic_backtest_claim', 'Atomically claim backtest concurrency slots'),
  ('0017_management_command_recovery_states', 'Add recoverable management command lifecycle states'),
  ('0018_command_audit_and_backtest_leases', 'Recover pending command audits and enforce backtest worker leases'),
  ('0019_backtest_owner_fenced_persistence', 'Fence all claimed backtest worker writes by live lease ownership'),
  ('0020_strategy_lab_fact_model', 'Add immutable strategy laboratory experiment facts and settlement revisions'),
  ('0021_strategy_lab_policy_and_artifacts', 'Add temporal policy captures, immutable strategy publications and trusted build facts'),
  ('0022_strategy_lab_snapshot_provider', 'Canonical immutable odds evidence and authoritative current-only Strategy Lab snapshots'),
  ('0024_automation_task_idempotent_ensure', 'Atomic idempotent automation task ensure RPC')
ON CONFLICT (version) DO NOTHING;

COMMIT;
