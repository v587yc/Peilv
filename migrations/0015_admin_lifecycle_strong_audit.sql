BEGIN;

CREATE OR REPLACE FUNCTION create_admin_user_audited(
  p_id UUID,
  p_username TEXT,
  p_display_name TEXT,
  p_password_hash TEXT,
  p_role TEXT,
  p_actor_id TEXT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  created admin_users%ROWTYPE;
BEGIN
  INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
  VALUES (p_actor_id, 'admin', 'admin.user_create.requested', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'pending'));

  BEGIN
    INSERT INTO admin_users(id, username, display_name, password_hash, role, is_active)
    VALUES (p_id, p_username, p_display_name, p_password_hash, p_role, TRUE)
    RETURNING * INTO created;
  EXCEPTION
    WHEN unique_violation THEN
      INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
      VALUES (p_actor_id, 'admin', 'admin.user_create.failed', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'failed', 'errorCode', 'ADMIN_ALREADY_EXISTS'));
      RETURN jsonb_build_object('ok', FALSE, 'error_code', 'ADMIN_ALREADY_EXISTS');
    WHEN OTHERS THEN
      INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
      VALUES (p_actor_id, 'admin', 'admin.user_create.failed', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'failed', 'errorCode', 'ADMIN_CREATE_FAILED'));
      RETURN jsonb_build_object('ok', FALSE, 'error_code', 'ADMIN_CREATE_FAILED');
  END;

  INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, new_value, metadata)
  VALUES (p_actor_id, 'admin', 'admin.user_create.succeeded', 'admin_user', created.id::TEXT, p_request_id,
    jsonb_build_object('id', created.id, 'username', created.username, 'displayName', created.display_name, 'role', created.role, 'isActive', created.is_active),
    jsonb_build_object('status', 'succeeded'));
  RETURN jsonb_build_object('ok', TRUE, 'user', to_jsonb(created) - 'password_hash');
END;
$$;

CREATE OR REPLACE FUNCTION update_admin_user_audited(
  p_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_display_name TEXT,
  p_role TEXT,
  p_is_active BOOLEAN,
  p_password_hash TEXT,
  p_actor_id TEXT,
  p_request_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous admin_users%ROWTYPE;
  updated admin_users%ROWTYPE;
  next_role TEXT;
  next_active BOOLEAN;
  failure_code TEXT;
BEGIN
  INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
  VALUES (p_actor_id, 'admin', 'admin.user_update.requested', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'pending'));

  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('admin_identity_guardrails', 0));
    SELECT * INTO previous FROM admin_users WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_NOT_FOUND'; END IF;
    IF p_expected_updated_at IS NULL OR previous.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_UPDATE_CONFLICT';
    END IF;
    IF p_role IS NOT NULL AND p_role NOT IN ('super_admin', 'operator', 'auditor') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_ROLE_INVALID';
    END IF;
    next_role := COALESCE(p_role, previous.role);
    next_active := COALESCE(p_is_active, previous.is_active);
    IF previous.role = 'super_admin' AND previous.is_active
       AND (next_role <> 'super_admin' OR NOT next_active)
       AND NOT EXISTS (SELECT 1 FROM admin_users WHERE id <> p_id AND role = 'super_admin' AND is_active) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LAST_ACTIVE_SUPER_ADMIN';
    END IF;
    UPDATE admin_users SET
      display_name = COALESCE(p_display_name, display_name), role = next_role, is_active = next_active,
      password_hash = COALESCE(p_password_hash, password_hash), updated_at = clock_timestamp()
    WHERE id = p_id AND updated_at = p_expected_updated_at RETURNING * INTO updated;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_UPDATE_CONFLICT'; END IF;
    IF p_password_hash IS NOT NULL OR next_role IS DISTINCT FROM previous.role OR next_active IS DISTINCT FROM previous.is_active THEN
      UPDATE admin_sessions SET revoked_at = NOW() WHERE admin_user_id = p_id AND revoked_at IS NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    failure_code := CASE SQLERRM
      WHEN 'ADMIN_NOT_FOUND' THEN 'ADMIN_NOT_FOUND'
      WHEN 'ADMIN_UPDATE_CONFLICT' THEN 'ADMIN_UPDATE_CONFLICT'
      WHEN 'LAST_ACTIVE_SUPER_ADMIN' THEN 'LAST_ACTIVE_SUPER_ADMIN'
      WHEN 'ADMIN_ROLE_INVALID' THEN 'ADMIN_ROLE_INVALID'
      ELSE 'ADMIN_UPDATE_FAILED'
    END;
    INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, metadata)
    VALUES (p_actor_id, 'admin', 'admin.user_update.failed', 'admin_user', p_id::TEXT, p_request_id, jsonb_build_object('status', 'failed', 'errorCode', failure_code));
    RETURN jsonb_build_object('ok', FALSE, 'error_code', failure_code);
  END;

  INSERT INTO audit_logs(actor_id, actor_type, action, object_type, object_id, request_id, old_value, new_value, metadata)
  VALUES (p_actor_id, 'admin', 'admin.user_update.succeeded', 'admin_user', p_id::TEXT, p_request_id,
    to_jsonb(previous) - 'password_hash', to_jsonb(updated) - 'password_hash',
    jsonb_build_object('status', 'succeeded', 'passwordChanged', p_password_hash IS NOT NULL));
  RETURN jsonb_build_object('ok', TRUE, 'user', to_jsonb(updated) - 'password_hash');
END;
$$;

REVOKE ALL ON FUNCTION create_admin_user_audited(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_admin_user_audited(UUID, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION create_admin_user_audited(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION update_admin_user_audited(UUID, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migrations(version, description)
VALUES ('0015_admin_lifecycle_strong_audit', 'Atomically audit administrator lifecycle mutations')
ON CONFLICT (version) DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
