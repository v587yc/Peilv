-- 0006: add immutable market-specific settlement evidence and result observations.
-- Legacy shared correctness columns remain for API compatibility and future writes mirror handicap only.
BEGIN;

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
  target_table TEXT;
  market_name TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['prediction_results', 'prediction_results_backtest']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS prediction_revision INTEGER', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS handicap_settlement_line REAL', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS total_settlement_line REAL', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS handicap_snapshot_id INTEGER', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS total_snapshot_id INTEGER', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS handicap_settlement_basis TEXT', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS total_settlement_basis TEXT', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS handicap_selection TEXT', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS total_selection TEXT', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS actual_score_margin INTEGER', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS actual_total_goals INTEGER', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_output JSONB', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_model_version TEXT', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_calibration_version TEXT', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_source_observed_at TIMESTAMPTZ', target_table);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS probability_quality_status TEXT NOT NULL DEFAULT ''unavailable''', target_table);

    FOREACH market_name IN ARRAY ARRAY['handicap', 'total']
    LOOP
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT', target_table, market_name || '_auto_outcome');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I BOOLEAN', target_table, market_name || '_auto_is_correct');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I BOOLEAN', target_table, market_name || '_manual_is_correct');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I BOOLEAN', target_table, market_name || '_effective_is_correct');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT NOT NULL DEFAULT ''pending''', target_table, market_name || '_automatic_status');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT NOT NULL DEFAULT ''unverified''', target_table, market_name || '_effective_status');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT', target_table, market_name || '_settlement_reason');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TIMESTAMPTZ', target_table, market_name || '_auto_verified_at');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TIMESTAMPTZ', target_table, market_name || '_manual_verified_at');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TIMESTAMPTZ', target_table, market_name || '_final_verified_at');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT', target_table, market_name || '_verified_by');
    END LOOP;
  END LOOP;
END $$;

COMMENT ON COLUMN prediction_results.is_correct IS 'Legacy API compatibility mirror for handicap effective correctness only; never use for total settlement.';
COMMENT ON COLUMN prediction_results_backtest.is_correct IS 'Legacy API compatibility mirror for handicap effective correctness only; never use for total settlement.';
COMMENT ON COLUMN prediction_results.handicap_auto_outcome IS 'Authoritative weighted outcome: win, half_win, push, half_loss, loss, or unavailable; accuracy must weight outcome rather than rely only on boolean correctness.';
COMMENT ON COLUMN prediction_results.total_auto_outcome IS 'Authoritative weighted outcome: win, half_win, push, half_loss, loss, or unavailable; accuracy must weight outcome rather than rely only on boolean correctness.';

ALTER TABLE learned_patterns ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'handicap';
ALTER TABLE learned_patterns_backtest ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'handicap';
DROP INDEX IF EXISTS learned_patterns_key_unique;
DROP INDEX IF EXISTS learned_patterns_backtest_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_market_key_unique
  ON learned_patterns(market, pattern_key, league);
CREATE UNIQUE INDEX IF NOT EXISTS learned_patterns_backtest_market_key_unique
  ON learned_patterns_backtest(market, pattern_key, league);

INSERT INTO schema_migrations(version, description)
VALUES (
  '0006_market_settlement_evidence',
  'Add match results, auditable market-specific settlement evidence, probability provenance, and market-scoped learned patterns'
)
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
