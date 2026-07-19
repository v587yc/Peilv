BEGIN;

CREATE OR REPLACE FUNCTION bootstrap_first_admin(
  p_id UUID,
  p_username TEXT,
  p_display_name TEXT,
  p_password_hash TEXT
)
RETURNS SETOF admin_users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_identity_guardrails', 0));
  IF EXISTS (SELECT 1 FROM admin_users) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_ALREADY_INITIALIZED';
  END IF;

  RETURN QUERY
  INSERT INTO admin_users(id, username, display_name, password_hash, role, is_active)
  VALUES (p_id, p_username, p_display_name, p_password_hash, 'super_admin', TRUE)
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION update_admin_user_guarded(
  p_id UUID,
  p_display_name TEXT DEFAULT NULL,
  p_role TEXT DEFAULT NULL,
  p_is_active BOOLEAN DEFAULT NULL,
  p_password_hash TEXT DEFAULT NULL
)
RETURNS SETOF admin_users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_user_row admin_users%ROWTYPE;
  next_role TEXT;
  next_active BOOLEAN;
  revoke_sessions BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_identity_guardrails', 0));
  SELECT * INTO current_user_row FROM admin_users WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_NOT_FOUND';
  END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('super_admin', 'operator', 'auditor') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_ROLE_INVALID';
  END IF;

  next_role := COALESCE(p_role, current_user_row.role);
  next_active := COALESCE(p_is_active, current_user_row.is_active);
  IF current_user_row.role = 'super_admin' AND current_user_row.is_active
     AND (next_role <> 'super_admin' OR NOT next_active)
     AND NOT EXISTS (
       SELECT 1 FROM admin_users
       WHERE id <> p_id AND role = 'super_admin' AND is_active
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LAST_ACTIVE_SUPER_ADMIN';
  END IF;

  revoke_sessions := p_password_hash IS NOT NULL
    OR next_role IS DISTINCT FROM current_user_row.role
    OR next_active IS DISTINCT FROM current_user_row.is_active;

  RETURN QUERY
  UPDATE admin_users
  SET display_name = COALESCE(p_display_name, display_name),
      role = next_role,
      is_active = next_active,
      password_hash = COALESCE(p_password_hash, password_hash),
      updated_at = NOW()
  WHERE id = p_id
  RETURNING *;

  IF revoke_sessions THEN
    UPDATE admin_sessions
    SET revoked_at = NOW()
    WHERE admin_user_id = p_id AND revoked_at IS NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION bootstrap_first_admin(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_admin_user_guarded(UUID, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION bootstrap_first_admin(UUID, TEXT, TEXT, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION update_admin_user_guarded(UUID, TEXT, TEXT, BOOLEAN, TEXT) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migrations(version, description)
VALUES ('0010_admin_identity_guardrails', 'Atomically bootstrap and guard administrator identity changes')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
