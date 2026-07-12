-- 0005: add durable T-30 match analysis scheduling and analysis-task serialization.
BEGIN;

WITH ranked_running_analysis AS (
  SELECT
    id,
    row_number() OVER (ORDER BY updated_at DESC, id DESC) AS position
  FROM automation_tasks
  WHERE status = 'running'
    AND task_type IN ('analysis', 'match-t30-analysis')
)
UPDATE automation_tasks
SET
  status = 'retrying',
  current_step = NULL,
  lock_owner = NULL,
  lock_expires_at = NULL,
  scheduled_at = NOW(),
  updated_at = NOW()
WHERE id IN (
  SELECT id
  FROM ranked_running_analysis
  WHERE position > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_tasks_single_running_analysis
  ON automation_tasks ((1))
  WHERE status = 'running'
    AND task_type IN ('analysis', 'match-t30-analysis');

CREATE INDEX IF NOT EXISTS automation_tasks_match_type_status_idx
  ON automation_tasks(match_id, task_type, status);

INSERT INTO schema_migrations(version, description)
VALUES (
  '0005_match_t30_analysis',
  'Add durable per-match T-30 analysis scheduling and serialize analysis tasks'
)
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
