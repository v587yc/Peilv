-- 0001: non-destructive production baseline and data-integrity hardening.
-- Existing duplicate rows are copied to migration_duplicate_archive before deletion.
-- The deterministic survivor is the newest updated/created row, then the greatest id.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) PRIMARY KEY,
  description TEXT NOT NULL,
  checksum TEXT,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- Create tables introduced after the original deployment before applying additive changes.
CREATE TABLE IF NOT EXISTS prediction_results_backtest (
  LIKE prediction_results INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS
);
CREATE TABLE IF NOT EXISTS learned_patterns_backtest (
  LIKE learned_patterns INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS
);
CREATE TABLE IF NOT EXISTS league_selections (
  id SERIAL PRIMARY KEY,
  date_key VARCHAR(20) NOT NULL,
  mode VARCHAR(20) NOT NULL,
  league_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_focused_leagues (
  id SERIAL PRIMARY KEY,
  league_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS backtest_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  start_date VARCHAR(10) NOT NULL,
  end_date VARCHAR(10) NOT NULL,
  "current_date" VARCHAR(10) NOT NULL,
  total_dates INTEGER NOT NULL DEFAULT 0,
  processed_dates INTEGER NOT NULL DEFAULT 0,
  total_matches INTEGER NOT NULL DEFAULT 0,
  analyzed_matches INTEGER NOT NULL DEFAULT 0,
  verified_matches INTEGER NOT NULL DEFAULT 0,
  correct_matches INTEGER NOT NULL DEFAULT 0,
  accuracy TEXT NOT NULL DEFAULT '0%',
  log JSONB NOT NULL DEFAULT '[]'::JSONB,
  result JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Additive compatibility changes for databases created from older setup scripts.
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'production';
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS strategy_version TEXT;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS weights_version TEXT;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS model_version TEXT;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS weights_snapshot JSONB;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS effective_is_correct BOOLEAN;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS effective_verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS auto_verified_at TIMESTAMPTZ;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS manually_verified_at TIMESTAMPTZ;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS manually_verified_by TEXT;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'backtest';
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS strategy_version TEXT;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS weights_version TEXT;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS model_version TEXT;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS weights_snapshot JSONB;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS effective_is_correct BOOLEAN;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS effective_verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS auto_verified_at TIMESTAMPTZ;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS manually_verified_at TIMESTAMPTZ;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS manually_verified_by TEXT;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE SEQUENCE IF NOT EXISTS prediction_results_backtest_id_seq;
ALTER SEQUENCE prediction_results_backtest_id_seq OWNED BY prediction_results_backtest.id;
ALTER TABLE prediction_results_backtest ALTER COLUMN id SET DEFAULT nextval('prediction_results_backtest_id_seq');
SELECT setval(
  'prediction_results_backtest_id_seq',
  GREATEST(COALESCE(MAX(id), 0) + 1, 1),
  false
) FROM prediction_results_backtest;
UPDATE prediction_results_backtest
SET id = nextval('prediction_results_backtest_id_seq')
WHERE id IS NULL;
ALTER TABLE prediction_results_backtest ALTER COLUMN id SET NOT NULL;

ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS strategy_version TEXT;
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS weights_version TEXT;
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS model_version TEXT;
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS training_window_start VARCHAR(8);
ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS training_window_end VARCHAR(8);

ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS strategy_version TEXT;
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS weights_version TEXT;
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS model_version TEXT;
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS training_window_start VARCHAR(8);
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS training_window_end VARCHAR(8);
CREATE SEQUENCE IF NOT EXISTS learned_patterns_backtest_id_seq;
ALTER SEQUENCE learned_patterns_backtest_id_seq OWNED BY learned_patterns_backtest.id;
ALTER TABLE learned_patterns_backtest ALTER COLUMN id SET DEFAULT nextval('learned_patterns_backtest_id_seq');
SELECT setval(
  'learned_patterns_backtest_id_seq',
  GREATEST(COALESCE(MAX(id), 0) + 1, 1),
  false
) FROM learned_patterns_backtest;
UPDATE learned_patterns_backtest
SET id = nextval('learned_patterns_backtest_id_seq')
WHERE id IS NULL;
ALTER TABLE learned_patterns_backtest ALTER COLUMN id SET NOT NULL;

ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE memory_bank ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE memory_bank ADD COLUMN IF NOT EXISTS compressed_at TIMESTAMPTZ;
ALTER TABLE memory_bank ALTER COLUMN original_id TYPE TEXT USING original_id::TEXT;

ALTER TABLE backtest_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE backtest_jobs ADD COLUMN IF NOT EXISTS current_step TEXT;
ALTER TABLE backtest_jobs ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backtest_jobs ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE backtest_jobs ADD COLUMN IF NOT EXISTS lock_owner TEXT;
ALTER TABLE backtest_jobs ADD COLUMN IF NOT EXISTS lock_expires_at TIMESTAMPTZ;
ALTER TABLE backtest_jobs ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE match_odds ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE match_odds ADD COLUMN IF NOT EXISTS source_observed_at TIMESTAMPTZ;
ALTER TABLE match_odds ADD COLUMN IF NOT EXISTS write_token TEXT;

-- Temporarily remove natural-key uniqueness so equivalent legacy date spellings can be normalized and deduplicated.
DO $$
DECLARE
  target RECORD;
  candidate RECORD;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('prediction_data', ARRAY['date_key']::TEXT[]),
      ('daily_reports', ARRAY['report_date']::TEXT[]),
      ('match_odds', ARRAY['match_id', 'match_date']::TEXT[]),
      ('prediction_results', ARRAY['match_id', 'match_date']::TEXT[]),
      ('league_selections', ARRAY['date_key', 'mode', 'league_name']::TEXT[])
    ) AS targets(table_name, column_names)
  LOOP
    FOR candidate IN
      SELECT constraint_entry.conname
      FROM pg_constraint constraint_entry
      WHERE constraint_entry.conrelid = to_regclass(format('public.%I', target.table_name))
        AND constraint_entry.contype = 'u'
        AND (
          SELECT array_agg(attribute_entry.attname::TEXT ORDER BY key_entry.ordinality)
          FROM unnest(constraint_entry.conkey) WITH ORDINALITY AS key_entry(attnum, ordinality)
          JOIN pg_attribute attribute_entry
            ON attribute_entry.attrelid = constraint_entry.conrelid
           AND attribute_entry.attnum = key_entry.attnum
        ) = target.column_names
    LOOP
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT %I',
        target.table_name,
        candidate.conname
      );
    END LOOP;

    FOR candidate IN
      SELECT index_namespace.nspname AS schema_name, index_relation.relname AS index_name
      FROM pg_index index_entry
      JOIN pg_class index_relation ON index_relation.oid = index_entry.indexrelid
      JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
      WHERE index_entry.indrelid = to_regclass(format('public.%I', target.table_name))
        AND index_entry.indisunique
        AND NOT index_entry.indisprimary
        AND index_entry.indpred IS NULL
        AND index_entry.indexprs IS NULL
        AND index_entry.indnkeyatts = cardinality(target.column_names)
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint constraint_entry
          WHERE constraint_entry.conindid = index_entry.indexrelid
        )
        AND (
          SELECT array_agg(attribute_entry.attname::TEXT ORDER BY key_entry.ordinality)
          FROM unnest(index_entry.indkey) WITH ORDINALITY AS key_entry(attnum, ordinality)
          JOIN pg_attribute attribute_entry
            ON attribute_entry.attrelid = index_entry.indrelid
           AND attribute_entry.attnum = key_entry.attnum
          WHERE key_entry.ordinality <= index_entry.indnkeyatts
        ) = target.column_names
    LOOP
      EXECUTE format('DROP INDEX %I.%I', candidate.schema_name, candidate.index_name);
    END LOOP;
  END LOOP;
END $$;

-- Convert the only supported legacy date spelling without changing its meaning.
UPDATE prediction_data SET date_key = replace(date_key, '-', '')
WHERE date_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
UPDATE match_odds SET match_date = replace(match_date, '-', '')
WHERE match_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
UPDATE daily_reports SET report_date = replace(report_date, '-', '')
WHERE report_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
UPDATE prediction_results SET match_date = replace(match_date, '-', '')
WHERE match_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
UPDATE prediction_results_backtest SET match_date = replace(match_date, '-', '')
WHERE match_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
UPDATE learned_patterns SET
  training_window_start = CASE
    WHEN training_window_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN replace(training_window_start, '-', '')
    ELSE training_window_start
  END,
  training_window_end = CASE
    WHEN training_window_end ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN replace(training_window_end, '-', '')
    ELSE training_window_end
  END;
UPDATE learned_patterns_backtest SET
  training_window_start = CASE
    WHEN training_window_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN replace(training_window_start, '-', '')
    ELSE training_window_start
  END,
  training_window_end = CASE
    WHEN training_window_end ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN replace(training_window_end, '-', '')
    ELSE training_window_end
  END;
UPDATE league_selections SET date_key = replace(date_key, '-', '')
WHERE date_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
UPDATE backtest_jobs SET
  start_date = CASE WHEN start_date ~ '^\d{4}-\d{2}-\d{2}$' THEN replace(start_date, '-', '') ELSE start_date END,
  end_date = CASE WHEN end_date ~ '^\d{4}-\d{2}-\d{2}$' THEN replace(end_date, '-', '') ELSE end_date END,
  "current_date" = CASE WHEN "current_date" ~ '^\d{4}-\d{2}-\d{2}$' THEN replace("current_date", '-', '') ELSE "current_date" END;

-- Duplicate preflight and archive: prediction_data(date_key).
WITH ranked AS (
  SELECT p.*, first_value(id) OVER (
    PARTITION BY date_key ORDER BY updated_at DESC NULLS LAST, id DESC
  ) AS retained_id,
  row_number() OVER (
    PARTITION BY date_key ORDER BY updated_at DESC NULLS LAST, id DESC
  ) AS duplicate_rank
  FROM prediction_data p
), archived AS (
  INSERT INTO migration_duplicate_archive(
    migration_version, table_name, natural_key, retained_id, archived_id, archived_row
  )
  SELECT '0001_production_baseline', 'prediction_data', jsonb_build_object('date_key', date_key),
         retained_id::TEXT, id::TEXT, to_jsonb(ranked) - 'retained_id' - 'duplicate_rank'
  FROM ranked WHERE duplicate_rank > 1
  ON CONFLICT (migration_version, table_name, archived_id) DO NOTHING
)
DELETE FROM prediction_data p USING ranked r WHERE r.duplicate_rank > 1 AND p.id = r.id;

-- Duplicate preflight and archive: daily_reports(report_date).
WITH ranked AS (
  SELECT d.*, first_value(id) OVER (
    PARTITION BY report_date ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS retained_id,
  row_number() OVER (
    PARTITION BY report_date ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS duplicate_rank
  FROM daily_reports d
), archived AS (
  INSERT INTO migration_duplicate_archive(
    migration_version, table_name, natural_key, retained_id, archived_id, archived_row
  )
  SELECT '0001_production_baseline', 'daily_reports', jsonb_build_object('report_date', report_date),
         retained_id::TEXT, id::TEXT, to_jsonb(ranked) - 'retained_id' - 'duplicate_rank'
  FROM ranked WHERE duplicate_rank > 1
  ON CONFLICT (migration_version, table_name, archived_id) DO NOTHING
)
DELETE FROM daily_reports d USING ranked r WHERE r.duplicate_rank > 1 AND d.id = r.id;

-- Duplicate preflight and archive: match_odds(match_id, match_date).
WITH ranked AS (
  SELECT m.*, first_value(id) OVER (
    PARTITION BY match_id, match_date ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS retained_id,
  row_number() OVER (
    PARTITION BY match_id, match_date ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS duplicate_rank
  FROM match_odds m
), archived AS (
  INSERT INTO migration_duplicate_archive(
    migration_version, table_name, natural_key, retained_id, archived_id, archived_row
  )
  SELECT '0001_production_baseline', 'match_odds',
         jsonb_build_object('match_id', match_id, 'match_date', match_date),
         retained_id::TEXT, id::TEXT, to_jsonb(ranked) - 'retained_id' - 'duplicate_rank'
  FROM ranked WHERE duplicate_rank > 1
  ON CONFLICT (migration_version, table_name, archived_id) DO NOTHING
)
DELETE FROM match_odds m USING ranked r WHERE r.duplicate_rank > 1 AND m.id = r.id;

-- Duplicate preflight and archive: production predictions.
WITH ranked AS (
  SELECT p.*, first_value(id) OVER (
    PARTITION BY match_id, match_date ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS retained_id,
  row_number() OVER (
    PARTITION BY match_id, match_date ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS duplicate_rank
  FROM prediction_results p
), archived AS (
  INSERT INTO migration_duplicate_archive(
    migration_version, table_name, natural_key, retained_id, archived_id, archived_row
  )
  SELECT '0001_production_baseline', 'prediction_results',
         jsonb_build_object('match_id', match_id, 'match_date', match_date),
         retained_id::TEXT, id::TEXT, to_jsonb(ranked) - 'retained_id' - 'duplicate_rank'
  FROM ranked WHERE duplicate_rank > 1
  ON CONFLICT (migration_version, table_name, archived_id) DO NOTHING
)
DELETE FROM prediction_results p USING ranked r WHERE r.duplicate_rank > 1 AND p.id = r.id;

-- Duplicate preflight and archive: learned_patterns(pattern_key, league).
WITH ranked AS (
  SELECT p.*, first_value(id) OVER (
    PARTITION BY pattern_key, league ORDER BY last_updated DESC NULLS LAST, id DESC
  ) AS retained_id,
  row_number() OVER (
    PARTITION BY pattern_key, league ORDER BY last_updated DESC NULLS LAST, id DESC
  ) AS duplicate_rank
  FROM learned_patterns p
), archived AS (
  INSERT INTO migration_duplicate_archive(
    migration_version, table_name, natural_key, retained_id, archived_id, archived_row
  )
  SELECT '0001_production_baseline', 'learned_patterns',
         jsonb_build_object('pattern_key', pattern_key, 'league', league),
         retained_id::TEXT, id::TEXT, to_jsonb(ranked) - 'retained_id' - 'duplicate_rank'
  FROM ranked WHERE duplicate_rank > 1
  ON CONFLICT (migration_version, table_name, archived_id) DO NOTHING
)
DELETE FROM learned_patterns p USING ranked r WHERE r.duplicate_rank > 1 AND p.id = r.id;

-- Duplicate preflight and archive: isolated backtest tables.
WITH ranked AS (
  SELECT p.*, first_value(id) OVER (
    PARTITION BY run_id, match_id, match_date
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS retained_id,
  row_number() OVER (
    PARTITION BY run_id, match_id, match_date
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  ) AS duplicate_rank
  FROM prediction_results_backtest p
  WHERE run_id IS NOT NULL
), archived AS (
  INSERT INTO migration_duplicate_archive(
    migration_version, table_name, natural_key, retained_id, archived_id, archived_row
  )
  SELECT '0001_production_baseline', 'prediction_results_backtest',
         jsonb_build_object('run_id', run_id, 'match_id', match_id, 'match_date', match_date),
         retained_id::TEXT, id::TEXT, to_jsonb(ranked) - 'retained_id' - 'duplicate_rank'
  FROM ranked WHERE duplicate_rank > 1
  ON CONFLICT (migration_version, table_name, archived_id) DO NOTHING
)
DELETE FROM prediction_results_backtest p USING ranked r WHERE r.duplicate_rank > 1 AND p.id = r.id;

WITH ranked AS (
  SELECT p.*, first_value(id) OVER (
    PARTITION BY pattern_key, league ORDER BY last_updated DESC NULLS LAST, id DESC
  ) AS retained_id,
  row_number() OVER (
    PARTITION BY pattern_key, league ORDER BY last_updated DESC NULLS LAST, id DESC
  ) AS duplicate_rank
  FROM learned_patterns_backtest p
), archived AS (
  INSERT INTO migration_duplicate_archive(
    migration_version, table_name, natural_key, retained_id, archived_id, archived_row
  )
  SELECT '0001_production_baseline', 'learned_patterns_backtest',
         jsonb_build_object('pattern_key', pattern_key, 'league', league),
         retained_id::TEXT, id::TEXT, to_jsonb(ranked) - 'retained_id' - 'duplicate_rank'
  FROM ranked WHERE duplicate_rank > 1
  ON CONFLICT (migration_version, table_name, archived_id) DO NOTHING
)
DELETE FROM learned_patterns_backtest p USING ranked r WHERE r.duplicate_rank > 1 AND p.id = r.id;

-- Duplicate preflight and archive: league selections and focused leagues.
WITH ranked AS (
  SELECT l.*, first_value(id) OVER (
    PARTITION BY date_key, mode, league_name ORDER BY created_at DESC NULLS LAST, id DESC
  ) AS retained_id,
  row_number() OVER (
    PARTITION BY date_key, mode, league_name ORDER BY created_at DESC NULLS LAST, id DESC
  ) AS duplicate_rank
  FROM league_selections l
), archived AS (
  INSERT INTO migration_duplicate_archive(
    migration_version, table_name, natural_key, retained_id, archived_id, archived_row
  )
  SELECT '0001_production_baseline', 'league_selections',
         jsonb_build_object('date_key', date_key, 'mode', mode, 'league_name', league_name),
         retained_id::TEXT, id::TEXT, to_jsonb(ranked) - 'retained_id' - 'duplicate_rank'
  FROM ranked WHERE duplicate_rank > 1
  ON CONFLICT (migration_version, table_name, archived_id) DO NOTHING
)
DELETE FROM league_selections l USING ranked r WHERE r.duplicate_rank > 1 AND l.id = r.id;

WITH ranked AS (
  SELECT l.*, first_value(id) OVER (
    PARTITION BY league_name ORDER BY created_at DESC NULLS LAST, id DESC
  ) AS retained_id,
  row_number() OVER (
    PARTITION BY league_name ORDER BY created_at DESC NULLS LAST, id DESC
  ) AS duplicate_rank
  FROM user_focused_leagues l
), archived AS (
  INSERT INTO migration_duplicate_archive(
    migration_version, table_name, natural_key, retained_id, archived_id, archived_row
  )
  SELECT '0001_production_baseline', 'user_focused_leagues', jsonb_build_object('league_name', league_name),
         retained_id::TEXT, id::TEXT, to_jsonb(ranked) - 'retained_id' - 'duplicate_rank'
  FROM ranked WHERE duplicate_rank > 1
  ON CONFLICT (migration_version, table_name, archived_id) DO NOTHING
)
DELETE FROM user_focused_leagues l USING ranked r WHERE r.duplicate_rank > 1 AND l.id = r.id;

-- Unique indexes are created only after duplicate inspection/archive/deletion.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'prediction_results_backtest'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE prediction_results_backtest
      ADD CONSTRAINT prediction_results_backtest_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'learned_patterns_backtest'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE learned_patterns_backtest
      ADD CONSTRAINT learned_patterns_backtest_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS prediction_data_date_key_unique ON prediction_data(date_key);
CREATE UNIQUE INDEX IF NOT EXISTS daily_reports_report_date_unique ON daily_reports(report_date);
CREATE UNIQUE INDEX IF NOT EXISTS match_odds_match_date_id_unique ON match_odds(match_id, match_date);

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
CREATE UNIQUE INDEX IF NOT EXISTS prediction_results_match_date_unique ON prediction_results(match_id, match_date);
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_key_unique ON learned_patterns(pattern_key, league);
CREATE UNIQUE INDEX IF NOT EXISTS prediction_results_backtest_run_match_unique
  ON prediction_results_backtest(run_id, match_id, match_date);
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_backtest_key_unique
  ON learned_patterns_backtest(pattern_key, league);
CREATE UNIQUE INDEX IF NOT EXISTS league_selections_date_mode_league_unique
  ON league_selections(date_key, mode, league_name);
CREATE UNIQUE INDEX IF NOT EXISTS user_focused_leagues_name_unique ON user_focused_leagues(league_name);
CREATE UNIQUE INDEX IF NOT EXISTS backtest_jobs_idempotency_unique
  ON backtest_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- NOT VALID preserves legacy anomalies for explicit remediation while enforcing YYYYMMDD for new writes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prediction_data_date_key_check') THEN
    ALTER TABLE prediction_data ADD CONSTRAINT prediction_data_date_key_check CHECK (
      date_key ~ '^[0-9]{8}$' AND to_char(to_date(date_key, 'YYYYMMDD'), 'YYYYMMDD') = date_key
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_odds_match_date_check') THEN
    ALTER TABLE match_odds ADD CONSTRAINT match_odds_match_date_check CHECK (
      match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_reports_report_date_check') THEN
    ALTER TABLE daily_reports ADD CONSTRAINT daily_reports_report_date_check CHECK (
      report_date ~ '^[0-9]{8}$' AND to_char(to_date(report_date, 'YYYYMMDD'), 'YYYYMMDD') = report_date
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prediction_results_match_date_check') THEN
    ALTER TABLE prediction_results ADD CONSTRAINT prediction_results_match_date_check CHECK (
      match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'league_selections_date_key_check') THEN
    ALTER TABLE league_selections ADD CONSTRAINT league_selections_date_key_check CHECK (
      date_key ~ '^[0-9]{8}$' AND to_char(to_date(date_key, 'YYYYMMDD'), 'YYYYMMDD') = date_key
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prediction_results_backtest_match_date_check') THEN
    ALTER TABLE prediction_results_backtest ADD CONSTRAINT prediction_results_backtest_match_date_check CHECK (
      match_date ~ '^[0-9]{8}$' AND to_char(to_date(match_date, 'YYYYMMDD'), 'YYYYMMDD') = match_date
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learned_patterns_training_start_check') THEN
    ALTER TABLE learned_patterns ADD CONSTRAINT learned_patterns_training_start_check CHECK (
      training_window_start IS NULL OR (
        training_window_start ~ '^[0-9]{8}$'
        AND to_char(to_date(training_window_start, 'YYYYMMDD'), 'YYYYMMDD') = training_window_start
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learned_patterns_training_end_check') THEN
    ALTER TABLE learned_patterns ADD CONSTRAINT learned_patterns_training_end_check CHECK (
      training_window_end IS NULL OR (
        training_window_end ~ '^[0-9]{8}$'
        AND to_char(to_date(training_window_end, 'YYYYMMDD'), 'YYYYMMDD') = training_window_end
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learned_patterns_backtest_training_start_check') THEN
    ALTER TABLE learned_patterns_backtest ADD CONSTRAINT learned_patterns_backtest_training_start_check CHECK (
      training_window_start IS NULL OR (
        training_window_start ~ '^[0-9]{8}$'
        AND to_char(to_date(training_window_start, 'YYYYMMDD'), 'YYYYMMDD') = training_window_start
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learned_patterns_backtest_training_end_check') THEN
    ALTER TABLE learned_patterns_backtest ADD CONSTRAINT learned_patterns_backtest_training_end_check CHECK (
      training_window_end IS NULL OR (
        training_window_end ~ '^[0-9]{8}$'
        AND to_char(to_date(training_window_end, 'YYYYMMDD'), 'YYYYMMDD') = training_window_end
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backtest_jobs_start_date_check') THEN
    ALTER TABLE backtest_jobs ADD CONSTRAINT backtest_jobs_start_date_check CHECK (
      start_date ~ '^[0-9]{8}$' AND to_char(to_date(start_date, 'YYYYMMDD'), 'YYYYMMDD') = start_date
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backtest_jobs_end_date_check') THEN
    ALTER TABLE backtest_jobs ADD CONSTRAINT backtest_jobs_end_date_check CHECK (
      end_date ~ '^[0-9]{8}$' AND to_char(to_date(end_date, 'YYYYMMDD'), 'YYYYMMDD') = end_date
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backtest_jobs_current_date_check') THEN
    ALTER TABLE backtest_jobs ADD CONSTRAINT backtest_jobs_current_date_check CHECK (
      "current_date" ~ '^[0-9]{8}$' AND to_char(to_date("current_date", 'YYYYMMDD'), 'YYYYMMDD') = "current_date"
    ) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS prediction_results_versions_idx
  ON prediction_results(strategy_version, weights_version, model_version);
CREATE INDEX IF NOT EXISTS learned_patterns_status_idx ON learned_patterns(status, published_at);

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

INSERT INTO audit_logs(action, object_type, object_id, metadata)
SELECT 'migration_duplicate_cleanup', 'schema', '0001_production_baseline',
       jsonb_build_object(
         'archived_rows', COUNT(*),
         'tables', COALESCE(jsonb_agg(DISTINCT table_name), '[]'::JSONB)
       )
FROM migration_duplicate_archive
WHERE migration_version = '0001_production_baseline'
HAVING NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'migration_duplicate_cleanup'
    AND object_type = 'schema'
    AND object_id = '0001_production_baseline'
);

INSERT INTO schema_migrations(version, description)
VALUES (
  '0001_production_baseline',
  'Archive and deterministically deduplicate legacy data; add canonical constraints, versions, audit, jobs, snapshots, and quality records'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
