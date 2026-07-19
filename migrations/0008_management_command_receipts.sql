CREATE TABLE IF NOT EXISTS management_command_receipts (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'executing' CHECK (status IN ('executing', 'succeeded', 'failed')),
  result_reference JSONB,
  safe_error TEXT,
  actor_id TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (action, idempotency_key)
);
CREATE INDEX IF NOT EXISTS management_command_receipts_status_idx ON management_command_receipts(status, updated_at);
