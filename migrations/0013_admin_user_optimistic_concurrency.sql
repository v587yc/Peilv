BEGIN;

DROP FUNCTION IF EXISTS update_admin_user_guarded(UUID, TEXT, TEXT, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION update_admin_user_guarded(
  p_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
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
  IF p_expected_updated_at IS NULL OR current_user_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_UPDATE_CONFLICT';
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
      updated_at = clock_timestamp()
  WHERE id = p_id AND updated_at = p_expected_updated_at
  RETURNING *;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ADMIN_UPDATE_CONFLICT';
  END IF;
  IF revoke_sessions THEN
    UPDATE admin_sessions
    SET revoked_at = NOW()
    WHERE admin_user_id = p_id AND revoked_at IS NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION update_admin_user_guarded(UUID, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION update_admin_user_guarded(UUID, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, TEXT) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migrations(version, description)
VALUES ('0013_admin_user_optimistic_concurrency', 'Require administrator version preconditions for guarded updates')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
