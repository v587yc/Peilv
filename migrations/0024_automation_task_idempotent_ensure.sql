-- Atomically ensure an automation task with a canonical idempotency contract.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION '0024 requires service_role; refusing to install permissive RPC ACLs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'automation_task_owner') THEN
    CREATE ROLE automation_task_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  ALTER ROLE automation_task_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END $$;

CREATE OR REPLACE FUNCTION public.ensure_automation_task(p_task JSONB)
RETURNS SETOF public.automation_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ensured public.automation_tasks;
  requested_attempt_count INTEGER;
  requested_max_attempts INTEGER;
  requested_schedule TIMESTAMPTZ;
  requested_updated_at TIMESTAMPTZ;
  requested_date DATE;
BEGIN
  IF p_task IS NULL OR jsonb_typeof(p_task) <> 'object' THEN
    RAISE EXCEPTION 'p_task must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_task ?& ARRAY['id','task_type','date_key','match_id','source','idempotency_key','status','attempt_count','max_attempts','payload','scheduled_at','updated_at']) THEN
    RAISE EXCEPTION 'p_task is missing required fields' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(p_task->>'id','') IS NULL OR length(p_task->>'id') > 128
     OR NULLIF(p_task->>'idempotency_key','') IS NULL OR length(p_task->>'idempotency_key') > 512
     OR p_task->>'date_key' !~ '^[0-9]{8}$' THEN
    RAISE EXCEPTION 'invalid task identity' USING ERRCODE = '22023';
  END IF;
  BEGIN
    requested_date := to_date(p_task->>'date_key','YYYYMMDD');
    IF to_char(requested_date,'YYYYMMDD') <> p_task->>'date_key' THEN RAISE EXCEPTION 'invalid date'; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid task identity' USING ERRCODE = '22023';
  END;
  IF p_task->>'task_type' NOT IN ('odds-fetch','crown-snapshot','analysis','match-t30-analysis','verify-learn-report') THEN
    RAISE EXCEPTION 'invalid task_type' USING ERRCODE = '22023';
  END IF;
  IF p_task->>'status' NOT IN ('pending','running','retrying','completed','failed') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023';
  END IF;
  IF p_task->>'source' NOT IN ('production','backtest') THEN
    RAISE EXCEPTION 'invalid source' USING ERRCODE = '22023';
  END IF;
  IF (p_task->>'match_id') IS NOT NULL AND length(p_task->>'match_id') > 20 THEN
    RAISE EXCEPTION 'invalid match_id' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_task->'attempt_count') <> 'number' OR jsonb_typeof(p_task->'max_attempts') <> 'number'
     OR (p_task->>'attempt_count') !~ '^[0-9]+$' OR (p_task->>'max_attempts') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invalid attempt bounds' USING ERRCODE = '22023';
  END IF;
  BEGIN
    requested_attempt_count := (p_task->>'attempt_count')::INTEGER;
    requested_max_attempts := (p_task->>'max_attempts')::INTEGER;
    IF requested_attempt_count NOT BETWEEN 0 AND 1000 OR requested_max_attempts NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid bounds'; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid attempt bounds' USING ERRCODE = '22023';
  END;
  IF jsonb_typeof(p_task->'payload') <> 'object' OR octet_length((p_task->'payload')::TEXT) > 262144 THEN
    RAISE EXCEPTION 'payload must be an object no larger than 256KiB' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_task->'scheduled_at') <> 'string' OR jsonb_typeof(p_task->'updated_at') <> 'string' THEN
    RAISE EXCEPTION 'scheduled_at and updated_at must be timestamp strings' USING ERRCODE = '22023';
  END IF;
  BEGIN
    requested_schedule := (p_task->>'scheduled_at')::TIMESTAMPTZ;
    requested_updated_at := (p_task->>'updated_at')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid timestamp' USING ERRCODE = '22023';
  END;
  INSERT INTO public.automation_tasks(
    id, task_type, date_key, match_id, source, idempotency_key, status,
    attempt_count, max_attempts, payload, scheduled_at, updated_at
  ) VALUES (
    p_task->>'id', p_task->>'task_type', p_task->>'date_key', NULLIF(p_task->>'match_id',''),
    COALESCE(NULLIF(p_task->>'source',''), 'production'), p_task->>'idempotency_key',
    COALESCE(NULLIF(p_task->>'status',''), 'pending'),
    requested_attempt_count,
    requested_max_attempts,
    COALESCE(p_task->'payload', '{}'::JSONB),
    requested_schedule,
    requested_updated_at
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO ensured;

  IF NOT FOUND THEN
    SELECT * INTO ensured
    FROM public.automation_tasks
    WHERE idempotency_key = p_task->>'idempotency_key';
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION '幂等任务查询失败';
  END IF;

  IF ensured.task_type IS DISTINCT FROM p_task->>'task_type'
     OR ensured.date_key IS DISTINCT FROM p_task->>'date_key'
     OR ensured.match_id IS DISTINCT FROM NULLIF(p_task->>'match_id','')
     OR ensured.source IS DISTINCT FROM p_task->>'source' THEN
    RAISE EXCEPTION 'idempotency key payload conflict' USING ERRCODE = 'P0001', DETAIL = 'IDEMPOTENCY_PAYLOAD_CONFLICT';
  END IF;

  RETURN NEXT ensured;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_automation_task(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_automation_task(JSONB) TO service_role;
ALTER FUNCTION public.ensure_automation_task(JSONB) OWNER TO automation_task_owner;
GRANT SELECT, INSERT ON public.automation_tasks TO automation_task_owner;

INSERT INTO schema_migrations(version,description)
VALUES('0024_automation_task_idempotent_ensure','Atomic idempotent automation task ensure RPC')
ON CONFLICT (version) DO NOTHING;
