BEGIN;

ALTER TABLE learned_patterns
  ALTER COLUMN total_predictions TYPE REAL USING total_predictions::REAL,
  ALTER COLUMN correct_predictions TYPE REAL USING correct_predictions::REAL;

ALTER TABLE learned_patterns_backtest
  ALTER COLUMN total_predictions TYPE REAL USING total_predictions::REAL,
  ALTER COLUMN correct_predictions TYPE REAL USING correct_predictions::REAL;

INSERT INTO schema_migrations(version, description)
VALUES (
  '0007_weighted_learning_samples',
  'Allow half-sample weighted totals and correctness in market-scoped learned patterns'
)
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
