BEGIN;

ALTER TABLE management_command_receipts
  ADD COLUMN IF NOT EXISTS audit_context JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_command_success_unique
  ON audit_logs(action, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND action LIKE '%.succeeded';

CREATE OR REPLACE FUNCTION record_management_command_effect_result(p_action TEXT, p_idempotency_key TEXT, p_result JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  UPDATE management_command_receipts
  SET result_reference = p_result, audit_context = COALESCE(audit_context, '{}'::JSONB) || '{"effectSucceeded":true}'::JSONB, updated_at = NOW()
  WHERE action = p_action AND idempotency_key = p_idempotency_key AND status = 'effect_started';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END $$;

CREATE OR REPLACE FUNCTION heartbeat_backtest_job(p_job_id TEXT, p_lock_owner TEXT, p_lease_seconds INTEGER DEFAULT 60)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  UPDATE backtest_jobs SET lock_expires_at = NOW() + make_interval(secs => GREATEST(10, LEAST(p_lease_seconds, 300))), updated_at = NOW()
  WHERE id = p_job_id AND status IN ('running', 'cancelling') AND lock_owner = p_lock_owner;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END $$;

CREATE OR REPLACE FUNCTION fail_claimed_backtest_job(p_job_id TEXT, p_lock_owner TEXT, p_safe_error TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  UPDATE backtest_jobs SET status = 'error', current_step = 'startup_failed', last_error = LEFT(p_safe_error, 500),
    lock_owner = NULL, lock_expires_at = NULL, ended_at = NOW(), updated_at = NOW()
  WHERE id = p_job_id AND status = 'running' AND lock_owner = p_lock_owner;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END $$;

CREATE OR REPLACE FUNCTION reconcile_expired_backtest_jobs(p_limit INTEGER DEFAULT 25)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  WITH expired AS (
    SELECT id FROM backtest_jobs WHERE status IN ('running', 'cancelling') AND lock_expires_at < NOW()
    ORDER BY backtest_jobs.lock_expires_at ASC FOR UPDATE SKIP LOCKED LIMIT GREATEST(1, LEAST(p_limit, 100))
  )
  UPDATE backtest_jobs j SET status = 'error', current_step = 'lease_expired', last_error = '回测任务租约过期，已由对账任务回收',
    lock_owner = NULL, lock_expires_at = NULL, ended_at = NOW(), updated_at = NOW()
  FROM expired WHERE j.id = expired.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END $$;

REVOKE ALL ON FUNCTION heartbeat_backtest_job(TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_management_command_effect_result(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_claimed_backtest_job(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_expired_backtest_jobs(INTEGER) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
  GRANT EXECUTE ON FUNCTION heartbeat_backtest_job(TEXT, TEXT, INTEGER) TO service_role;
  GRANT EXECUTE ON FUNCTION record_management_command_effect_result(TEXT, TEXT, JSONB) TO service_role;
  GRANT EXECUTE ON FUNCTION fail_claimed_backtest_job(TEXT, TEXT, TEXT) TO service_role;
  GRANT EXECUTE ON FUNCTION reconcile_expired_backtest_jobs(INTEGER) TO service_role;
END IF; END $$;

INSERT INTO schema_migrations(version, description)
VALUES ('0018_command_audit_and_backtest_leases', 'Recover pending command audits and enforce backtest worker leases')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
