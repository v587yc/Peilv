BEGIN;

CREATE TABLE IF NOT EXISTS admin_login_attempt_buckets (
  key_hash CHAR(64) PRIMARY KEY,
  key_kind TEXT NOT NULL CHECK (key_kind IN ('global', 'source', 'source_subject', 'unknown', 'account')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_login_attempt_buckets_cleanup_idx ON admin_login_attempt_buckets(updated_at);

CREATE TABLE IF NOT EXISTS admin_login_attempt_reservations (
  token_hash CHAR(64) PRIMARY KEY,
  global_key CHAR(64) NOT NULL,
  source_key CHAR(64),
  subject_key CHAR(64) NOT NULL,
  source_subject_key CHAR(64),
  subject_known BOOLEAN NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_expiry_idx ON admin_login_attempt_reservations(expires_at);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_global_idx ON admin_login_attempt_reservations(global_key, expires_at);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_source_idx ON admin_login_attempt_reservations(source_key, expires_at);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_subject_idx ON admin_login_attempt_reservations(subject_key, expires_at);
CREATE INDEX IF NOT EXISTS admin_login_attempt_reservations_source_subject_idx ON admin_login_attempt_reservations(source_subject_key, expires_at);
ALTER TABLE admin_login_attempt_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_login_attempt_reservations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION reserve_admin_login_attempt(
  p_token_hash CHAR(64), p_global_key CHAR(64), p_source_key CHAR(64),
  p_subject_key CHAR(64), p_source_subject_key CHAR(64), p_subject_known BOOLEAN
)
RETURNS TABLE(allowed BOOLEAN, retry_after_seconds INTEGER, reservation_key CHAR(64))
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE active_count INTEGER; attempts INTEGER; bucket_key CHAR(64); bucket_kind TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_reservations', 0));
  DELETE FROM admin_login_attempt_reservations WHERE token_hash IN (
    SELECT token_hash FROM admin_login_attempt_reservations WHERE expires_at <= NOW() LIMIT 100
  );
  DELETE FROM admin_login_attempt_buckets WHERE key_hash IN (
    SELECT key_hash FROM admin_login_attempt_buckets
    WHERE updated_at < NOW() - INTERVAL '24 hours' AND key_kind <> 'global' LIMIT 100
  );
  IF EXISTS (SELECT 1 FROM admin_login_attempt_reservations WHERE token_hash = p_token_hash) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='RESERVATION_REPLAY';
  END IF;

  FOR bucket_key, bucket_kind IN
    SELECT p_global_key, 'global' UNION ALL
    SELECT p_source_key, 'source' WHERE p_source_key IS NOT NULL UNION ALL
    SELECT p_source_subject_key, 'source_subject' WHERE p_source_subject_key IS NOT NULL UNION ALL
    SELECT p_subject_key, CASE WHEN p_subject_known THEN 'account' ELSE 'unknown' END
  LOOP
    INSERT INTO admin_login_attempt_buckets(key_hash,key_kind) VALUES(bucket_key,bucket_kind)
    ON CONFLICT(key_hash) DO NOTHING;
    UPDATE admin_login_attempt_buckets SET
      attempt_count=CASE WHEN window_started_at < NOW()-INTERVAL '1 minute' THEN 1 ELSE attempt_count+1 END,
      window_started_at=CASE WHEN window_started_at < NOW()-INTERVAL '1 minute' THEN NOW() ELSE window_started_at END,
      updated_at=NOW() WHERE key_hash=bucket_key RETURNING attempt_count INTO attempts;
    IF bucket_kind='global' AND attempts>120 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
    IF bucket_kind='source' AND attempts>30 THEN RETURN QUERY SELECT FALSE,2,NULL::CHAR(64); RETURN; END IF;
    IF bucket_kind='source_subject' AND attempts>10 THEN RETURN QUERY SELECT FALSE,3,NULL::CHAR(64); RETURN; END IF;
    IF bucket_kind='unknown' AND attempts>30 THEN RETURN QUERY SELECT FALSE,2,NULL::CHAR(64); RETURN; END IF;
  END LOOP;

  SELECT COUNT(*)::INTEGER INTO active_count FROM admin_login_attempt_reservations WHERE expires_at>NOW() AND global_key=p_global_key;
  IF active_count>=12 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
  IF p_source_key IS NOT NULL THEN
    SELECT COUNT(*)::INTEGER INTO active_count FROM admin_login_attempt_reservations WHERE expires_at>NOW() AND source_key=p_source_key;
    IF active_count>=4 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
  END IF;
  IF p_source_subject_key IS NOT NULL THEN
    SELECT COUNT(*)::INTEGER INTO active_count FROM admin_login_attempt_reservations WHERE expires_at>NOW() AND source_subject_key=p_source_subject_key;
    IF active_count>=2 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
  ELSIF NOT p_subject_known THEN
    SELECT COUNT(*)::INTEGER INTO active_count FROM admin_login_attempt_reservations WHERE expires_at>NOW() AND subject_key=p_subject_key;
    IF active_count>=4 THEN RETURN QUERY SELECT FALSE,1,NULL::CHAR(64); RETURN; END IF;
  END IF;

  INSERT INTO admin_login_attempt_reservations(token_hash,global_key,source_key,subject_key,source_subject_key,subject_known,expires_at)
  VALUES(p_token_hash,p_global_key,p_source_key,p_subject_key,p_source_subject_key,p_subject_known,NOW()+INTERVAL '15 seconds');
  RETURN QUERY SELECT TRUE,0,p_token_hash;
END; $$;

CREATE OR REPLACE FUNCTION settle_admin_login_attempt(p_token_hash CHAR(64), p_succeeded BOOLEAN)
RETURNS TABLE(settled BOOLEAN, audit_failure BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE reservation admin_login_attempt_reservations%ROWTYPE; next_failures INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_login_reservations', 0));
  SELECT * INTO reservation FROM admin_login_attempt_reservations WHERE token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT FALSE,FALSE; RETURN; END IF;
  DELETE FROM admin_login_attempt_reservations WHERE token_hash=p_token_hash;
  IF p_succeeded IS NULL THEN
    RETURN QUERY SELECT TRUE,FALSE; RETURN;
  END IF;
  IF p_succeeded THEN
    UPDATE admin_login_attempt_buckets SET failure_count=0,updated_at=NOW()
    WHERE key_hash IN(reservation.subject_key,reservation.source_subject_key);
    RETURN QUERY SELECT TRUE,FALSE; RETURN;
  END IF;
  UPDATE admin_login_attempt_buckets SET failure_count=failure_count+1,updated_at=NOW()
  WHERE key_hash=reservation.subject_key RETURNING failure_count INTO next_failures;
  RETURN QUERY SELECT TRUE,(next_failures=1 OR (next_failures & (next_failures-1))=0 OR next_failures%25=0);
END; $$;

CREATE OR REPLACE FUNCTION cleanup_admin_login_attempts(p_limit INTEGER DEFAULT 500)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE removed INTEGER:=0; count_now INTEGER;
BEGIN
  WITH deleted AS (DELETE FROM admin_login_attempt_reservations WHERE token_hash IN
    (SELECT token_hash FROM admin_login_attempt_reservations WHERE expires_at<=NOW() LIMIT LEAST(GREATEST(p_limit,1),5000)) RETURNING 1)
  SELECT COUNT(*) INTO count_now FROM deleted; removed:=removed+count_now;
  WITH deleted AS (DELETE FROM admin_login_attempt_buckets WHERE key_hash IN
    (SELECT key_hash FROM admin_login_attempt_buckets WHERE updated_at<NOW()-INTERVAL '24 hours' AND key_kind<>'global' LIMIT LEAST(GREATEST(p_limit,1),5000)) RETURNING 1)
  SELECT COUNT(*) INTO count_now FROM deleted; RETURN removed+count_now;
END; $$;

REVOKE ALL ON TABLE admin_login_attempt_buckets,admin_login_attempt_reservations FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_admin_login_attempt(CHAR,CHAR,CHAR,CHAR,CHAR,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_admin_login_attempt(CHAR,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION cleanup_admin_login_attempts(INTEGER) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION reserve_admin_login_attempt(CHAR,CHAR,CHAR,CHAR,CHAR,BOOLEAN) TO service_role;
  GRANT EXECUTE ON FUNCTION settle_admin_login_attempt(CHAR,BOOLEAN) TO service_role;
  GRANT EXECUTE ON FUNCTION cleanup_admin_login_attempts(INTEGER) TO service_role;
END IF; END $$;
INSERT INTO schema_migrations(version,description) VALUES('0012_admin_login_reservations','Replace login check-record window with atomic bounded reservations') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
