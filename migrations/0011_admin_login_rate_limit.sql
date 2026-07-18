BEGIN;

CREATE TABLE IF NOT EXISTS admin_login_rate_limits (
  key_hash CHAR(64) PRIMARY KEY,
  key_kind TEXT NOT NULL CHECK (key_kind IN ('username', 'ip')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_login_rate_limits_cleanup_idx
  ON admin_login_rate_limits(updated_at);
ALTER TABLE admin_login_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION check_admin_login_rate_limit(
  p_username_key CHAR(64),
  p_ip_key CHAR(64) DEFAULT NULL
)
RETURNS TABLE(allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  retry_seconds INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_rate_limit:' || p_username_key, 0));
  IF p_ip_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_rate_limit:' || p_ip_key, 0));
  END IF;
  SELECT COALESCE(MAX(GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())))::INTEGER)), 0)
  INTO retry_seconds
  FROM admin_login_rate_limits
  WHERE key_hash IN (p_username_key, p_ip_key) AND locked_until > NOW();
  RETURN QUERY SELECT retry_seconds = 0, retry_seconds;
END;
$$;

CREATE OR REPLACE FUNCTION record_admin_login_failure(
  p_username_key CHAR(64),
  p_ip_key CHAR(64) DEFAULT NULL
)
RETURNS TABLE(allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_key CHAR(64);
  current_kind TEXT;
  current_threshold INTEGER;
  next_failures INTEGER;
  lock_seconds INTEGER;
  max_retry INTEGER := 0;
BEGIN
  FOR current_key, current_kind, current_threshold IN
    SELECT p_username_key, 'username', 5
    UNION ALL
    SELECT p_ip_key, 'ip', 20 WHERE p_ip_key IS NOT NULL
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_rate_limit:' || current_key, 0));
    INSERT INTO admin_login_rate_limits(key_hash, key_kind, failure_count, window_started_at, updated_at)
    VALUES (current_key, current_kind, 0, NOW(), NOW())
    ON CONFLICT (key_hash) DO NOTHING;

    UPDATE admin_login_rate_limits
    SET failure_count = CASE WHEN window_started_at < NOW() - INTERVAL '15 minutes' THEN 1 ELSE failure_count + 1 END,
        window_started_at = CASE WHEN window_started_at < NOW() - INTERVAL '15 minutes' THEN NOW() ELSE window_started_at END,
        updated_at = NOW()
    WHERE key_hash = current_key
    RETURNING failure_count INTO next_failures;

    lock_seconds := CASE
      WHEN next_failures < current_threshold THEN 0
      ELSE LEAST(300, 5 * (2 ^ LEAST(6, next_failures - current_threshold)))::INTEGER
    END;
    IF lock_seconds > 0 THEN
      UPDATE admin_login_rate_limits
      SET locked_until = GREATEST(COALESCE(locked_until, NOW()), NOW() + make_interval(secs => lock_seconds)), updated_at = NOW()
      WHERE key_hash = current_key;
      max_retry := GREATEST(max_retry, lock_seconds);
    END IF;
  END LOOP;
  RETURN QUERY SELECT max_retry = 0, max_retry;
END;
$$;

CREATE OR REPLACE FUNCTION clear_admin_login_failures(
  p_username_key CHAR(64),
  p_ip_key CHAR(64) DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM admin_login_rate_limits WHERE key_hash IN (p_username_key, p_ip_key);
END;
$$;

REVOKE ALL ON TABLE admin_login_rate_limits FROM PUBLIC;
REVOKE ALL ON FUNCTION check_admin_login_rate_limit(CHAR, CHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_admin_login_failure(CHAR, CHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION clear_admin_login_failures(CHAR, CHAR) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION check_admin_login_rate_limit(CHAR, CHAR) TO service_role;
    GRANT EXECUTE ON FUNCTION record_admin_login_failure(CHAR, CHAR) TO service_role;
    GRANT EXECUTE ON FUNCTION clear_admin_login_failures(CHAR, CHAR) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migrations(version, description)
VALUES ('0011_admin_login_rate_limit', 'Add persistent atomic administrator login throttling')
ON CONFLICT (version) DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
