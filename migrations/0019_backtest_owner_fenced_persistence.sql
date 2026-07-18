BEGIN;

CREATE OR REPLACE FUNCTION persist_claimed_backtest_job(
  p_job JSONB,
  p_lock_owner TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE backtest_jobs AS jobs SET
    status = p_job->>'status',
    current_step = p_job->>'current_step',
    "current_date" = p_job->>'current_date',
    total_dates = COALESCE((p_job->>'total_dates')::INTEGER, jobs.total_dates),
    processed_dates = COALESCE((p_job->>'processed_dates')::INTEGER, jobs.processed_dates),
    total_matches = COALESCE((p_job->>'total_matches')::INTEGER, jobs.total_matches),
    analyzed_matches = COALESCE((p_job->>'analyzed_matches')::INTEGER, jobs.analyzed_matches),
    verified_matches = COALESCE((p_job->>'verified_matches')::INTEGER, jobs.verified_matches),
    correct_matches = COALESCE((p_job->>'correct_matches')::INTEGER, jobs.correct_matches),
    accuracy = COALESCE(p_job->>'accuracy', jobs.accuracy),
    log = COALESCE(p_job->'log', jobs.log),
    result = p_job->'result',
    last_error = p_job->>'last_error',
    ended_at = NULLIF(p_job->>'ended_at', '')::TIMESTAMPTZ,
    lock_owner = CASE WHEN p_job->>'status' IN ('running', 'cancelling') THEN jobs.lock_owner ELSE NULL END,
    lock_expires_at = CASE WHEN p_job->>'status' IN ('running', 'cancelling') THEN jobs.lock_expires_at ELSE NULL END,
    updated_at = NOW()
  WHERE jobs.id = p_job->>'id'
    AND jobs.lock_owner = p_lock_owner
    AND jobs.lock_expires_at >= NOW()
    AND jobs.status IN ('running', 'cancelling')
    AND p_job->>'status' IN ('running', 'cancelling', 'done', 'error', 'timed_out', 'cancelled');
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

REVOKE ALL ON FUNCTION persist_claimed_backtest_job(JSONB, TEXT) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON FUNCTION persist_claimed_backtest_job(JSONB, TEXT) FROM anon; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON FUNCTION persist_claimed_backtest_job(JSONB, TEXT) FROM authenticated; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN GRANT EXECUTE ON FUNCTION persist_claimed_backtest_job(JSONB, TEXT) TO service_role; END IF; END $$;

INSERT INTO schema_migrations(version, description)
VALUES ('0019_backtest_owner_fenced_persistence', 'Fence all claimed backtest worker writes by live lease ownership')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
