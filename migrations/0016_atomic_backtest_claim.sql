BEGIN;

-- Serialize backtest admission in the database so separate application
-- instances cannot both pass a count-then-insert concurrency check.
CREATE OR REPLACE FUNCTION claim_backtest_job(
  p_job JSONB,
  p_max_concurrent INTEGER,
  p_resume BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id TEXT := p_job->>'id';
  v_active INTEGER;
  v_status TEXT;
BEGIN
  IF v_id IS NULL OR v_id = '' OR p_max_concurrent < 1 THEN
    RAISE EXCEPTION 'invalid backtest claim';
  END IF;

  -- Transaction-scoped and shared by every application instance.
  PERFORM pg_advisory_xact_lock(hashtext('backtest_jobs:active-slot'));

  IF p_resume THEN
    SELECT status INTO v_status FROM backtest_jobs WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('claimed', FALSE, 'reason', 'not_found'); END IF;
    IF v_status IN ('running', 'cancelling') THEN
      RETURN jsonb_build_object('claimed', FALSE, 'reason', 'already_active');
    END IF;
  ELSIF EXISTS (SELECT 1 FROM backtest_jobs WHERE id = v_id) THEN
    RETURN jsonb_build_object('claimed', FALSE, 'reason', 'duplicate');
  END IF;

  SELECT count(*) INTO v_active
  FROM backtest_jobs
  WHERE status IN ('running', 'cancelling') AND id <> v_id;
  IF v_active >= p_max_concurrent THEN
    RETURN jsonb_build_object('claimed', FALSE, 'reason', 'limit');
  END IF;

  INSERT INTO backtest_jobs (
    id, idempotency_key, status, current_step, start_date, end_date, "current_date",
    total_dates, processed_dates, total_matches, analyzed_matches,
    verified_matches, correct_matches, accuracy, log, result, last_error,
    attempt_count, max_attempts, lock_owner, lock_expires_at,
    started_at, ended_at, updated_at
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
  )
  ON CONFLICT (id) DO UPDATE SET
    status = 'running', current_step = EXCLUDED.current_step,
    start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
    "current_date" = EXCLUDED."current_date", total_dates = EXCLUDED.total_dates,
    processed_dates = EXCLUDED.processed_dates, total_matches = EXCLUDED.total_matches,
    analyzed_matches = EXCLUDED.analyzed_matches, verified_matches = EXCLUDED.verified_matches,
    correct_matches = EXCLUDED.correct_matches, accuracy = EXCLUDED.accuracy,
    log = EXCLUDED.log, result = EXCLUDED.result, last_error = NULL,
    attempt_count = backtest_jobs.attempt_count + 1,
    max_attempts = EXCLUDED.max_attempts, lock_owner = EXCLUDED.lock_owner,
    lock_expires_at = EXCLUDED.lock_expires_at, ended_at = NULL, updated_at = NOW()
  WHERE p_resume AND backtest_jobs.status NOT IN ('running', 'cancelling');

  IF NOT FOUND THEN RETURN jsonb_build_object('claimed', FALSE, 'reason', 'conflict'); END IF;
  RETURN jsonb_build_object('claimed', TRUE, 'jobId', v_id);
END;
$$;

REVOKE ALL ON FUNCTION claim_backtest_job(JSONB, INTEGER, BOOLEAN) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION claim_backtest_job(JSONB, INTEGER, BOOLEAN) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migrations(version, description)
VALUES ('0016_atomic_backtest_claim', 'Atomically claim backtest concurrency slots')
ON CONFLICT (version) DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
