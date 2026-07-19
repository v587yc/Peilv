\set ON_ERROR_STOP on

-- Privileged, separately controlled bootstrap. This file creates NOLOGIN group
-- roles only. Provision runtime LOGIN roles through deployment secrets, then
-- GRANT strategy_lab_reader or strategy_lab_writer to those LOGIN roles.
BEGIN;

DO $$
DECLARE role_name TEXT;
BEGIN
 FOREACH role_name IN ARRAY ARRAY[
  'strategy_lab_owner','strategy_lab_migrator','strategy_lab_reader',
  'strategy_lab_writer','strategy_lab_maintenance'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
  END IF;
  EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
 END LOOP;
END $$;

ALTER ROLE strategy_lab_owner NOINHERIT;
ALTER ROLE strategy_lab_migrator NOINHERIT;
ALTER ROLE strategy_lab_reader NOINHERIT;
ALTER ROLE strategy_lab_writer INHERIT;
ALTER ROLE strategy_lab_maintenance INHERIT;

GRANT strategy_lab_owner TO strategy_lab_migrator;
GRANT strategy_lab_reader TO strategy_lab_writer;
GRANT strategy_lab_writer TO strategy_lab_maintenance;

REVOKE ALL ON SCHEMA public FROM strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance;
GRANT USAGE ON SCHEMA public TO strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance;

-- Readiness needs only the registered migration identifier. Keep the ledger
-- otherwise private and immutable to runtime roles; writer and maintenance
-- receive this column grant only through their existing reader inheritance.
REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC,strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance;
DO $$
DECLARE column_name TEXT; role_name TEXT;
BEGIN
 FOR column_name IN
  SELECT attname FROM pg_attribute
  WHERE attrelid='public.schema_migrations'::regclass AND attnum>0 AND NOT attisdropped
 LOOP
  EXECUTE format(
   'REVOKE SELECT (%1$I),INSERT (%1$I),UPDATE (%1$I),REFERENCES (%1$I) ON TABLE public.schema_migrations FROM PUBLIC,strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance',
   column_name
  );
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format(
     'REVOKE SELECT (%1$I),INSERT (%1$I),UPDATE (%1$I),REFERENCES (%1$I) ON TABLE public.schema_migrations FROM %2$I',
     column_name,role_name
    );
   END IF;
  END LOOP;
 END LOOP;
END $$;
GRANT SELECT (version) ON TABLE public.schema_migrations TO strategy_lab_reader;

DO $$
DECLARE
 table_name TEXT;
 function_signature TEXT;
 role_name TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY[
  'strategy_lab_snapshot_sets','strategy_lab_snapshot_items','strategy_lab_experiment_runs',
  'strategy_lab_predictions','strategy_lab_settlements','strategy_lab_command_receipts',
  'strategy_lab_match_facts','strategy_lab_focused_league_baselines',
  'strategy_lab_focused_league_events','strategy_lab_league_policy_artifacts',
  'strategy_lab_league_policy_captures','strategy_lab_strategy_artifacts',
   'strategy_lab_strategy_publications','strategy_lab_build_artifacts','strategy_lab_match_result_revisions'
 ] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC,strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance',table_name);
  EXECUTE format('GRANT SELECT ON TABLE %I TO strategy_lab_reader,strategy_lab_writer',table_name);
  EXECUTE format('GRANT INSERT ON TABLE %I TO strategy_lab_writer',table_name);
  EXECUTE format('DROP POLICY IF EXISTS strategy_lab_reader_select ON %I',table_name);
  EXECUTE format('DROP POLICY IF EXISTS strategy_lab_writer_select ON %I',table_name);
  EXECUTE format('DROP POLICY IF EXISTS strategy_lab_writer_insert ON %I',table_name);
  EXECUTE format('CREATE POLICY strategy_lab_reader_select ON %I FOR SELECT TO strategy_lab_reader USING (true)',table_name);
  EXECUTE format('CREATE POLICY strategy_lab_writer_select ON %I FOR SELECT TO strategy_lab_writer USING (true)',table_name);
  EXECUTE format('CREATE POLICY strategy_lab_writer_insert ON %I FOR INSERT TO strategy_lab_writer WITH CHECK (true)',table_name);
 END LOOP;

 -- Runtime reads these FK/evidence sources but cannot mutate them.
 FOREACH table_name IN ARRAY ARRAY['odds_snapshots','match_results','strategy_versions'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance',table_name);
  EXECUTE format('GRANT SELECT ON TABLE %I TO strategy_lab_reader,strategy_lab_writer',table_name);
 END LOOP;

 FOREACH function_signature IN ARRAY ARRAY[
  'strategy_lab_reject_fact_mutation()',
  'strategy_lab_validate_snapshot_item_asof()',
  'strategy_lab_validate_snapshot_item_completeness()',
  'strategy_lab_validate_snapshot_set_insert()',
  'strategy_lab_validate_prediction_snapshot()',
  'strategy_lab_validate_receipt_transition()',
  'strategy_lab_validate_settlement_revision()',
  'strategy_lab_validate_settlement_evidence()',
  'strategy_lab_validate_run_transition()',
   'strategy_lab_validate_run_insert()',
   'strategy_lab_reject_result_revision_mutation()',
   'strategy_lab_validate_match_result_revision()',
   'strategy_lab_validate_trusted_settlement()',
  'strategy_lab_canonicalize_text(text)',
  'strategy_lab_validate_match_fact_insert()',
  'strategy_lab_validate_focused_baseline_insert()',
  'strategy_lab_validate_focused_baseline_complete()',
  'strategy_lab_validate_focused_event_insert()',
  'strategy_lab_validate_policy_artifact()',
  'strategy_lab_validate_strategy_artifact()',
   'strategy_lab_validate_publication_insert()'
   ,'odds_snapshots_reject_mutation()'
 ] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance',function_signature);
 END LOOP;

 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON TABLE public.schema_migrations FROM %I',role_name);
   FOREACH table_name IN ARRAY ARRAY[
    'strategy_lab_snapshot_sets','strategy_lab_snapshot_items','strategy_lab_experiment_runs',
    'strategy_lab_predictions','strategy_lab_settlements','strategy_lab_command_receipts',
    'strategy_lab_match_facts','strategy_lab_focused_league_baselines',
    'strategy_lab_focused_league_events','strategy_lab_league_policy_artifacts',
    'strategy_lab_league_policy_captures','strategy_lab_strategy_artifacts',
     'strategy_lab_strategy_publications','strategy_lab_build_artifacts','strategy_lab_match_result_revisions'
   ] LOOP EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name); END LOOP;
   FOREACH function_signature IN ARRAY ARRAY[
    'strategy_lab_reject_fact_mutation()','strategy_lab_validate_snapshot_item_asof()',
    'strategy_lab_validate_snapshot_item_completeness()','strategy_lab_validate_snapshot_set_insert()',
    'strategy_lab_validate_prediction_snapshot()','strategy_lab_validate_receipt_transition()',
    'strategy_lab_validate_settlement_revision()','strategy_lab_validate_settlement_evidence()',
     'strategy_lab_validate_run_transition()','strategy_lab_validate_run_insert()',
     'strategy_lab_reject_result_revision_mutation()','strategy_lab_validate_match_result_revision()',
     'strategy_lab_validate_trusted_settlement()',
    'strategy_lab_canonicalize_text(text)','strategy_lab_validate_match_fact_insert()',
    'strategy_lab_validate_focused_baseline_insert()','strategy_lab_validate_focused_baseline_complete()',
    'strategy_lab_validate_focused_event_insert()','strategy_lab_validate_policy_artifact()',
     'strategy_lab_validate_strategy_artifact()','strategy_lab_validate_publication_insert()'
     ,'odds_snapshots_reject_mutation()'
   ] LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',function_signature,role_name); END LOOP;
  END IF;
 END LOOP;
END $$;

-- Trigger functions remain invoker-security. The writer needs this one helper
-- to canonicalize valid baseline/event input; all other direct EXECUTE grants
-- stay revoked above. Maintenance inherits it through writer by design.
GRANT EXECUTE ON FUNCTION public.strategy_lab_canonicalize_text(text) TO strategy_lab_writer;

GRANT UPDATE(status,error_summary,started_at,finished_at,updated_at)
 ON strategy_lab_experiment_runs TO strategy_lab_writer;
GRANT UPDATE(status,last_audit_error_code,audit_attempts,updated_at,audited_at)
 ON strategy_lab_command_receipts TO strategy_lab_writer;
REVOKE UPDATE,DELETE ON strategy_lab_match_result_revisions FROM strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance;

DROP POLICY IF EXISTS strategy_lab_writer_update ON strategy_lab_experiment_runs;
CREATE POLICY strategy_lab_writer_update ON strategy_lab_experiment_runs
 FOR UPDATE TO strategy_lab_writer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS strategy_lab_writer_update ON strategy_lab_command_receipts;
CREATE POLICY strategy_lab_writer_update ON strategy_lab_command_receipts
 FOR UPDATE TO strategy_lab_writer USING (true) WITH CHECK (true);

-- No Strategy Lab table uses a sequence today. Keep sequence access denied by
-- default; add an explicit named sequence grant if a future migration adds one.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance;

-- Ownership transfer is deliberately last. Every ACL and policy mutation above
-- therefore runs in the privileged bootstrap session while it still owns (or
-- can administer) the objects; no post-transfer mutation relies on NOINHERIT.
DO $$
DECLARE table_name TEXT; function_signature TEXT;
BEGIN
 FOREACH table_name IN ARRAY ARRAY[
  'strategy_lab_snapshot_sets','strategy_lab_snapshot_items','strategy_lab_experiment_runs',
  'strategy_lab_predictions','strategy_lab_settlements','strategy_lab_command_receipts',
  'strategy_lab_match_facts','strategy_lab_focused_league_baselines',
  'strategy_lab_focused_league_events','strategy_lab_league_policy_artifacts',
  'strategy_lab_league_policy_captures','strategy_lab_strategy_artifacts',
   'strategy_lab_strategy_publications','strategy_lab_build_artifacts','strategy_lab_match_result_revisions'
 ] LOOP EXECUTE format('ALTER TABLE %I OWNER TO strategy_lab_owner',table_name); END LOOP;
 FOREACH function_signature IN ARRAY ARRAY[
  'strategy_lab_reject_fact_mutation()','strategy_lab_validate_snapshot_item_asof()',
  'strategy_lab_validate_snapshot_item_completeness()','strategy_lab_validate_snapshot_set_insert()',
  'strategy_lab_validate_prediction_snapshot()','strategy_lab_validate_receipt_transition()',
  'strategy_lab_validate_settlement_revision()','strategy_lab_validate_settlement_evidence()',
  'strategy_lab_validate_run_transition()','strategy_lab_validate_run_insert()',
  'strategy_lab_reject_result_revision_mutation()','strategy_lab_validate_match_result_revision()',
  'strategy_lab_validate_trusted_settlement()',
  'strategy_lab_canonicalize_text(text)','strategy_lab_validate_match_fact_insert()',
  'strategy_lab_validate_focused_baseline_insert()','strategy_lab_validate_focused_baseline_complete()',
  'strategy_lab_validate_focused_event_insert()','strategy_lab_validate_policy_artifact()',
  'strategy_lab_validate_strategy_artifact()','strategy_lab_validate_publication_insert()',
  'odds_snapshots_reject_mutation()'
 ] LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO strategy_lab_owner',function_signature); END LOOP;
END $$;

COMMIT;
