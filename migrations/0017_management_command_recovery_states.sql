BEGIN;

ALTER TABLE management_command_receipts
  DROP CONSTRAINT IF EXISTS management_command_receipts_status_check;

UPDATE management_command_receipts SET status = 'accepted' WHERE status = 'executing';
UPDATE management_command_receipts SET status = 'completed' WHERE status = 'succeeded';

ALTER TABLE management_command_receipts
  ADD CONSTRAINT management_command_receipts_status_check
  CHECK (status IN ('accepted', 'effect_started', 'effect_succeeded', 'audit_pending', 'completed', 'failed'));

COMMENT ON COLUMN management_command_receipts.status IS
  'Recoverable command lifecycle: accepted -> effect_started -> effect_succeeded -> audit_pending -> completed; failed is only valid before a successful effect.';

INSERT INTO schema_migrations(version, description)
VALUES ('0017_management_command_recovery_states', 'Add recoverable management command lifecycle states')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
