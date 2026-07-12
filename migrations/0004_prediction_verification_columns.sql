-- 0004: add verification columns missing from legacy prediction tables.
BEGIN;

ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS manual_is_correct BOOLEAN;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS effective_is_correct BOOLEAN;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS water_verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS total_verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS effective_verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS auto_is_correct BOOLEAN;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS actual_handicap_trend TEXT;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS actual_water_direction TEXT;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS auto_verified_at TIMESTAMPTZ;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS manually_verified_at TIMESTAMPTZ;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS manually_verified_by TEXT;
ALTER TABLE prediction_results ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS manual_is_correct BOOLEAN;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS effective_is_correct BOOLEAN;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS water_verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS total_verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS effective_verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS auto_is_correct BOOLEAN;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS actual_handicap_trend TEXT;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS actual_water_direction TEXT;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS auto_verified_at TIMESTAMPTZ;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS manually_verified_at TIMESTAMPTZ;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS manually_verified_by TEXT;
ALTER TABLE prediction_results_backtest ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

INSERT INTO schema_migrations(version, description)
VALUES (
  '0004_prediction_verification_columns',
  'Add prediction verification columns omitted by legacy schema upgrades'
)
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
