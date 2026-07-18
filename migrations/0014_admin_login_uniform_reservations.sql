BEGIN;

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
NOTIFY pgrst, 'reload schema';
COMMIT;
