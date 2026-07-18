BEGIN;

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'operator', 'auditor')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_users_username_format CHECK (username ~ '^[a-z0-9._-]{3,64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_unique ON admin_users(LOWER(username));
CREATE INDEX IF NOT EXISTS admin_users_role_active_idx ON admin_users(role, is_active);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'operator', 'auditor')),
  username TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_sessions_user_idx ON admin_sessions(admin_user_id, expires_at);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at) WHERE revoked_at IS NULL;

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version, description)
VALUES ('0009_admin_identity', 'Add password administrators, persistent sessions, and role assignments')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
