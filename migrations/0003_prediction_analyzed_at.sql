-- 0003: record the completion time of each AI analysis.
BEGIN;

ALTER TABLE prediction_results
  ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;

ALTER TABLE prediction_results_backtest
  ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;

INSERT INTO schema_migrations(version, description)
VALUES (
  '0003_prediction_analyzed_at',
  'Record the latest successful AI analysis time for production and backtest predictions'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
