import "server-only";
import type { StrategyLabSqlClient } from "./postgres-repository";
import type { StrategyLabProductionDependencyState } from "./production-server";

export type StrategyLabReadinessCode =
  | "STRATEGY_LAB_CONFIGURATION_MISSING"
  | "STRATEGY_LAB_DEPENDENCIES_INCOMPLETE"
  | "STRATEGY_LAB_DATABASE_UNAVAILABLE";

export type StrategyLabReadiness =
  | { readonly status: "ready" }
  | { readonly status: "unavailable"; readonly errorCode: StrategyLabReadinessCode };

export interface StrategyLabReadinessInput {
  readonly configured: boolean;
  readonly dependencies: StrategyLabProductionDependencyState;
  readonly sqlClient: StrategyLabSqlClient | null;
}

const unavailable = (errorCode: StrategyLabReadinessCode): StrategyLabReadiness => Object.freeze({ status: "unavailable", errorCode });

const STRATEGY_LAB_TABLES = Object.freeze([
  "strategy_lab_snapshot_sets", "strategy_lab_snapshot_items", "strategy_lab_experiment_runs",
  "strategy_lab_predictions", "strategy_lab_settlements", "strategy_lab_command_receipts",
  "strategy_lab_match_facts", "strategy_lab_focused_league_baselines", "strategy_lab_focused_league_events",
  "strategy_lab_league_policy_artifacts", "strategy_lab_league_policy_captures",
  "strategy_lab_strategy_artifacts", "strategy_lab_strategy_publications", "strategy_lab_build_artifacts",
  "strategy_lab_match_result_revisions",
] as const);

export const STRATEGY_LAB_SECURITY_CATALOG_PROBE = `
WITH expected_tables(table_name) AS (
  VALUES ${STRATEGY_LAB_TABLES.map(table => `('${table}')`).join(",")}
), expected_policies(table_name,policy_name,command_name,role_name) AS (
  SELECT table_name,'strategy_lab_reader_select','SELECT','strategy_lab_reader' FROM expected_tables
  UNION ALL SELECT table_name,'strategy_lab_writer_select','SELECT','strategy_lab_writer' FROM expected_tables
  UNION ALL SELECT table_name,'strategy_lab_writer_insert','INSERT','strategy_lab_writer' FROM expected_tables
  UNION ALL VALUES
    ('strategy_lab_experiment_runs','strategy_lab_writer_update','UPDATE','strategy_lab_writer'),
    ('strategy_lab_command_receipts','strategy_lab_writer_update','UPDATE','strategy_lab_writer')
), actual_policies AS (
  SELECT tablename AS table_name,policyname AS policy_name,cmd AS command_name,permissive,
    qual,with_check,unnest(roles)::text AS role_name
  FROM pg_policies WHERE schemaname='public' AND tablename IN (SELECT table_name FROM expected_tables)
), identity AS (
  SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication
  FROM pg_roles r WHERE r.rolname=current_user
), expected_roles(role_name) AS (
  VALUES ('strategy_lab_owner'),('strategy_lab_migrator'),('strategy_lab_reader'),
    ('strategy_lab_writer'),('strategy_lab_maintenance')
), expected_relations AS (
  SELECT c.oid,c.relacl,c.relowner,c.relkind
  FROM expected_tables e
  JOIN pg_namespace n ON n.nspname='public'
  JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=e.table_name AND c.relkind='r'
), normalized_relation_acl AS (
  SELECT r.oid,
    CASE
      WHEN r.relacl IS NULL THEN acldefault((CASE WHEN r.relkind='S' THEN 'S' ELSE 'r' END)::"char",r.relowner)
      WHEN array_ndims(r.relacl)=1 AND cardinality(r.relacl)>0 THEN r.relacl
      ELSE NULL::aclitem[]
    END AS acl_items
  FROM expected_relations r
), public_table_acl AS (
  SELECT r.oid,acl.grantee,acl.privilege_type,acl.is_grantable
  FROM normalized_relation_acl r
  CROSS JOIN LATERAL aclexplode(r.acl_items) acl
), normalized_default_table_acl AS (
  SELECT d.oid,
    CASE
      WHEN array_ndims(d.defaclacl)=1 AND cardinality(d.defaclacl)>0 THEN d.defaclacl
      ELSE NULL::aclitem[]
    END AS acl_items
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid=d.defaclnamespace
  WHERE n.nspname='public' AND d.defaclobjtype='r'
), public_default_table_acl AS (
  SELECT d.oid,acl.grantee,acl.privilege_type,acl.is_grantable
  FROM normalized_default_table_acl d
  CROSS JOIN LATERAL aclexplode(d.acl_items) acl
), mutable_columns(table_name,column_name) AS (
  VALUES
    ('strategy_lab_experiment_runs','status'),('strategy_lab_experiment_runs','error_summary'),
    ('strategy_lab_experiment_runs','started_at'),('strategy_lab_experiment_runs','finished_at'),
    ('strategy_lab_experiment_runs','updated_at'),('strategy_lab_command_receipts','status'),
    ('strategy_lab_command_receipts','last_audit_error_code'),('strategy_lab_command_receipts','audit_attempts'),
    ('strategy_lab_command_receipts','updated_at'),('strategy_lab_command_receipts','audited_at')
)
SELECT
  (SELECT count(*)=15 FROM expected_tables e JOIN pg_class c ON c.relname=e.table_name JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public' WHERE c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='strategy_lab_owner') AS tables_secure,
  ((SELECT count(*)=47 FROM actual_policies)
    AND (SELECT count(*)=47 FROM expected_policies e JOIN actual_policies a USING(table_name,policy_name,command_name,role_name)
      WHERE a.permissive='PERMISSIVE' AND COALESCE(a.qual,'true')='true' AND COALESCE(a.with_check,'true')='true')) AS policies_secure,
  NOT EXISTS(SELECT 1 FROM actual_policies WHERE role_name IN ('public','anon','authenticated')) AS policies_private,
  NOT EXISTS(
    SELECT 1 FROM public_table_acl
    WHERE grantee=0 AND privilege_type IN('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
  ) AS public_denied,
  NOT EXISTS(
    SELECT 1 FROM public_default_table_acl
    WHERE grantee=0 AND privilege_type IN('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
  ) AS default_public_denied,
  NOT EXISTS(
    SELECT 1 FROM pg_roles r CROSS JOIN expected_relations e
    WHERE r.rolname IN('anon','authenticated')
      AND has_table_privilege(r.oid,e.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) AS anonymous_denied,
  has_column_privilege(current_user,'public.schema_migrations','version','SELECT')
    AND NOT has_table_privilege(current_user,'public.schema_migrations','SELECT')
    AND NOT has_table_privilege(current_user,'public.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT EXISTS(
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='schema_migrations' AND c.column_name<>'version'
        AND has_column_privilege(current_user,'public.schema_migrations',c.column_name,'SELECT')
    ) AS migration_read_limited,
  NOT EXISTS(
    SELECT 1 FROM pg_class c
    CROSS JOIN LATERAL aclexplode(
      CASE
        WHEN c.relacl IS NULL THEN acldefault((CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END)::"char",c.relowner)
        WHEN array_ndims(c.relacl)=1 AND cardinality(c.relacl)>0 THEN c.relacl
        ELSE NULL::aclitem[]
      END
    ) acl
    WHERE c.oid='public.schema_migrations'::regclass AND acl.grantee=0
      AND acl.privilege_type IN('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
  ) AND NOT EXISTS(
    SELECT 1 FROM pg_attribute a
    CROSS JOIN LATERAL aclexplode(
      CASE WHEN array_ndims(a.attacl)=1 AND cardinality(a.attacl)>0 THEN a.attacl ELSE NULL::aclitem[] END
    ) acl
    WHERE a.attrelid='public.schema_migrations'::regclass AND a.attnum>0 AND NOT a.attisdropped
      AND acl.grantee=0 AND acl.privilege_type IN('SELECT','INSERT','UPDATE','REFERENCES')
  ) AS migration_public_denied,
  NOT EXISTS(
    SELECT 1 FROM pg_roles r
    WHERE r.rolname IN('anon','authenticated') AND (
      has_table_privilege(r.oid,'public.schema_migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR EXISTS(
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema='public' AND c.table_name='schema_migrations'
          AND has_column_privilege(r.oid,'public.schema_migrations',c.column_name,'SELECT,INSERT,UPDATE,REFERENCES')
      )
    )
  ) AS migration_anonymous_denied,
  has_schema_privilege(current_user,'public','USAGE') AS schema_allowed,
  NOT has_schema_privilege(current_user,'public','CREATE') AS schema_limited,
  (SELECT bool_and(has_table_privilege(current_user,format('public.%I',table_name),'SELECT,INSERT')) FROM expected_tables) AS runtime_allowed,
  NOT EXISTS(SELECT 1 FROM expected_tables WHERE has_table_privilege(current_user,format('public.%I',table_name),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS runtime_limited,
  (SELECT bool_and(has_column_privilege(current_user,format('public.%I',table_name),column_name,'UPDATE')) FROM mutable_columns)
    AND NOT EXISTS(
      SELECT 1 FROM information_schema.columns c JOIN expected_tables e ON e.table_name=c.table_name
      WHERE c.table_schema='public'
        AND NOT EXISTS(SELECT 1 FROM mutable_columns m WHERE m.table_name=c.table_name AND m.column_name=c.column_name)
        AND has_column_privilege(current_user,format('public.%I',c.table_name),c.column_name,'UPDATE')
    ) AS updates_allowed,
  has_table_privilege(current_user,'public.odds_snapshots','SELECT')
    AND NOT has_table_privilege(current_user,'public.odds_snapshots','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND has_table_privilege(current_user,'public.match_results','SELECT')
    AND has_table_privilege(current_user,'public.strategy_versions','SELECT')
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='odds_snapshots' AND column_name='hash_version')
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='odds_snapshots' AND column_name='canonical_content_hash')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.odds_snapshots'::regclass AND conname='odds_snapshots_hash_contract_check')
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.odds_snapshots'::regclass AND tgname='odds_snapshots_append_only' AND NOT tgisinternal)
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.strategy_lab_snapshot_items'::regclass AND conname='strategy_lab_snapshot_items_role_check')
    AND EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='strategy_lab_snapshot_items' AND indexname='strategy_lab_snapshot_items_one_current_unique') AS base_reads_allowed,
  has_function_privilege('strategy_lab_writer','public.strategy_lab_canonicalize_text(text)','EXECUTE') AS canonical_execute_allowed,
  NOT EXISTS(
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(
      CASE
        WHEN p.proacl IS NULL THEN acldefault('f',p.proowner)
        WHEN array_ndims(p.proacl)=1 AND cardinality(p.proacl)>0 THEN p.proacl
        ELSE NULL::aclitem[]
      END
    ) acl
    WHERE n.nspname='public' AND p.proname='strategy_lab_canonicalize_text'
      AND p.proargtypes='25'::oidvector AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
  )
    AND NOT EXISTS(
      SELECT 1 FROM pg_roles r
      WHERE r.rolname IN('anon','authenticated')
        AND has_function_privilege(r.rolname,'public.strategy_lab_canonicalize_text(text)','EXECUTE')
    ) AS canonical_execute_private,
  EXISTS(SELECT 1 FROM schema_migrations WHERE version='0023_strategy_lab_trusted_settlement')
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='strategy_lab_predictions' AND column_name='evidence_contract_version')
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='strategy_lab_settlements' AND column_name='evidence_hash')
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.strategy_lab_match_result_revisions'::regclass AND tgname='strategy_lab_match_result_revisions_append_only' AND NOT tgisinternal)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.strategy_lab_settlements'::regclass AND tgname='strategy_lab_settlements_validate_trusted' AND NOT tgisinternal) AS migration_registered,
  pg_has_role(current_user,'strategy_lab_writer','MEMBER') AS writer_member,
  NOT pg_has_role(current_user,'strategy_lab_owner','MEMBER') AS owner_isolated,
  (SELECT NOT(rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication) FROM identity) AS identity_safe,
  (SELECT count(*)=5 FROM expected_roles e JOIN pg_roles r ON r.rolname=e.role_name
    WHERE NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole
      AND NOT r.rolcreatedb AND NOT r.rolreplication) AS roles_safe
`;

function catalogIsReady(row: Record<string, unknown> | undefined): boolean {
  return !!row && ["tables_secure", "policies_secure", "policies_private", "public_denied", "default_public_denied", "schema_allowed",
    "anonymous_denied", "migration_read_limited", "migration_public_denied", "migration_anonymous_denied",
    "schema_limited", "runtime_allowed", "runtime_limited", "updates_allowed", "base_reads_allowed",
    "canonical_execute_allowed", "canonical_execute_private", "migration_registered", "writer_member", "owner_isolated",
    "identity_safe", "roles_safe"].every(key => row[key] === true);
}

export async function checkStrategyLabReadiness(input: StrategyLabReadinessInput): Promise<StrategyLabReadiness> {
  if (!input.configured) return unavailable("STRATEGY_LAB_CONFIGURATION_MISSING");
  if (!input.sqlClient) return unavailable("STRATEGY_LAB_DATABASE_UNAVAILABLE");
  try {
    await input.sqlClient.transaction(async transaction => {
      await transaction.query("SET TRANSACTION READ ONLY");
      const catalog = await transaction.query<Record<string, unknown>>(STRATEGY_LAB_SECURITY_CATALOG_PROBE);
      if (!catalogIsReady(catalog.rows[0])) throw new Error("strategy lab security contract unavailable");
      for (const table of STRATEGY_LAB_TABLES) await transaction.query(`SELECT * FROM ${table} LIMIT 0`);
    });
  } catch {
    return unavailable("STRATEGY_LAB_DATABASE_UNAVAILABLE");
  }
  if (input.dependencies.status !== "ready") return unavailable("STRATEGY_LAB_DEPENDENCIES_INCOMPLETE");
  return Object.freeze({ status: "ready" });
}
