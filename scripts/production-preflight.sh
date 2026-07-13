#!/usr/bin/env bash
set -Eeuo pipefail

usage='Usage: production-preflight.sh <release-id> <commit-sha> <source-run-id> <source-run-attempt> <source-artifact-id> <archive-sha256> <request-id> <migration-csv>'
release_id="${1:?$usage}"
commit_sha="${2:?$usage}"
source_run_id="${3:?$usage}"
source_run_attempt="${4:?$usage}"
source_artifact_id="${5:?$usage}"
archive_sha="${6:?$usage}"
request_id="${7:?$usage}"
migration_csv="${8:-}"

if [[ ! "$release_id" =~ ^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$ ]] ||
   [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]] ||
   [[ "$release_id" != "r${source_run_id}-a${source_run_attempt}-${commit_sha:0:12}" ]] ||
   [[ ! "$source_run_id" =~ ^[1-9][0-9]*$ ]] ||
   [[ ! "$source_run_attempt" =~ ^[1-9][0-9]*$ ]] ||
   [[ ! "$source_artifact_id" =~ ^[1-9][0-9]*$ ]] ||
   [[ ! "$archive_sha" =~ ^[0-9a-f]{64}$ ]] ||
   [[ ! "$request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  printf 'Invalid candidate provenance\n' >&2
  exit 1
fi
if [[ -n "$migration_csv" && ! "$migration_csv" =~ ^[0-9]{4}_[a-z0-9_]+\.sql=[0-9]{4}_[a-z0-9_]+(,[0-9]{4}_[a-z0-9_]+\.sql=[0-9]{4}_[a-z0-9_]+)*$ ]]; then
  printf 'Invalid migration list\n' >&2
  exit 1
fi

base=/opt/peilv
current_release_path="$(readlink -f "$base/current" 2>/dev/null || true)"
current_release="${current_release_path##*/}"
target_release="$base/releases/$release_id"
backup_path="$base/backups/peilv-before-$release_id.dump"
blockers=()
checks=()
pending=()
unknown=()
declared_versions=()

check_passed() { checks+=("$1=passed"); }
check_blocked() { checks+=("$1=blocked"); blockers+=("$2"); }

if [[ -z "$current_release_path" || ! -d "$current_release_path" ]]; then
  check_blocked current_release "Current release is invalid"
else
  check_passed current_release
fi
if [[ -e "$target_release" || -e "$backup_path" ]]; then
  check_blocked target_paths "Target release or backup already exists"
else
  check_passed target_paths
fi

for unit in peilv.service peilv-dispatch.timer peilv-reconcile.timer; do
  if [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" != active ]]; then
    check_blocked "unit:$unit" "Required unit is not active: $unit"
  else
    check_passed "unit:$unit"
  fi
done

if systemctl list-jobs --no-legend --no-pager | grep -Eq 'peilv-(dispatch|reconcile|service)'; then
  printf 'A peilv systemd job is currently running\n' >&2
  exit 1
fi
check_passed systemd_jobs

opt_available_kb=0
for mount in / /opt; do
  available_kb="$(df -Pk "$mount" | awk 'NR == 2 { print $4 }')"
  if (( available_kb < 2097152 )); then
    check_blocked "disk:$mount" "Less than 2 GiB is available under $mount"
  else
    check_passed "disk:$mount"
  fi
  [[ "$mount" == /opt ]] && opt_available_kb="$available_kb"
done

if ss -lntp | grep -Eq '[:.]5000[[:space:]]'; then
  check_passed production_port
else
  check_blocked production_port "Production port 5000 is not listening"
fi

for container in local-data-postgres-1 local-data-postgrest-1 local-data-gateway-1; do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" == true ]]; then
    check_passed "container:$container"
  else
    check_blocked "container:$container" "Required data container is not running: $container"
  fi
done

mapfile -t applied_versions < <(
  docker exec local-data-postgres-1 sh -lc \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select version from schema_migrations order by applied_at, version;"' 2>/dev/null || true
)

if [[ -n "$migration_csv" ]]; then
  IFS=',' read -r -a migration_entries <<<"$migration_csv"
  for migration_entry in "${migration_entries[@]}"; do
    migration="${migration_entry%%=*}"
    version="${migration_entry#*=}"
    declared_versions+=("$version")
    aliases=("$version")
    [[ "$migration" == "0001_production_baseline.sql" ]] && aliases+=("0001_canonical_baseline")
    found=0
    for alias in "${aliases[@]}"; do
      if printf '%s\n' "${applied_versions[@]}" | grep -Fxq "$alias"; then
        found=1
        break
      fi
    done
    (( found == 0 )) && pending+=("$migration")
  done
fi

for applied in "${applied_versions[@]}"; do
  [[ -z "$applied" ]] && continue
  [[ "$applied" == "0001_canonical_baseline" ]] && applied="0001_production_baseline"
  if ! printf '%s\n' "${declared_versions[@]}" | grep -Fxq "$applied"; then
    unknown+=("$applied")
  fi
done
if (( ${#unknown[@]} > 0 )); then
  check_blocked migration_ledger "Database contains migrations unknown to the candidate"
else
  check_passed migration_ledger
fi

if [[ -f "$base/shared/app.env" ]]; then
  env_owner="$(stat -c '%U' "$base/shared/app.env")"
  env_mode="$(stat -c '%a' "$base/shared/app.env")"
  if [[ "$env_owner" == root ]] && (( (8#$env_mode & 022) == 0 )); then
    check_passed shared_environment
  else
    check_blocked shared_environment "Shared environment file ownership or mode is unsafe"
  fi
else
  check_blocked shared_environment "Shared environment file is missing"
fi

if [[ -f "$base/shared/app.env" ]] && (
  set -a
  . "$base/shared/app.env"
  set +a
  curl -fsS -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
    http://127.0.0.1:5000/api/storage/health >/dev/null
); then
  check_passed storage_health
else
  check_blocked storage_health "Production storage health check failed"
fi

join_lines() { local IFS=$'\n'; printf '%s' "$*"; }
STATUS="$([[ ${#blockers[@]} -eq 0 ]] && printf passed || printf blocked)" \
RELEASE_ID="$release_id" COMMIT_SHA="$commit_sha" SOURCE_RUN_ID="$source_run_id" \
SOURCE_RUN_ATTEMPT="$source_run_attempt" SOURCE_ARTIFACT_ID="$source_artifact_id" \
ARCHIVE_SHA="$archive_sha" REQUEST_ID="$request_id" CURRENT_RELEASE="$current_release" \
TARGET_RELEASE="$target_release" BACKUP_PATH="$backup_path" OPT_AVAILABLE_KB="$opt_available_kb" \
CHECKS="$(join_lines "${checks[@]}")" BLOCKERS="$(join_lines "${blockers[@]}")" \
PENDING="$(join_lines "${pending[@]}")" APPLIED="$(join_lines "${applied_versions[@]}")" \
UNKNOWN="$(join_lines "${unknown[@]}")" node <<'NODE'
const lines = key => (process.env[key] || "").split("\n").filter(Boolean);
const checks = lines("CHECKS").map(value => {
  const separator = value.lastIndexOf("=");
  return { name: value.slice(0, separator), status: value.slice(separator + 1) };
});
const result = {
  schemaVersion: 1,
  status: process.env.STATUS,
  requestId: process.env.REQUEST_ID,
  candidate: {
    releaseId: process.env.RELEASE_ID,
    commitSha: process.env.COMMIT_SHA,
    sourceRunId: Number(process.env.SOURCE_RUN_ID),
    sourceRunAttempt: Number(process.env.SOURCE_RUN_ATTEMPT),
    sourceArtifactId: Number(process.env.SOURCE_ARTIFACT_ID),
    archiveSha256: process.env.ARCHIVE_SHA,
  },
  currentRelease: process.env.CURRENT_RELEASE || null,
  targetReleasePath: process.env.TARGET_RELEASE,
  rollbackRelease: process.env.CURRENT_RELEASE || null,
  databaseBackupPath: process.env.BACKUP_PATH,
  checks,
  migrations: { applied: lines("APPLIED"), pending: lines("PENDING"), unknown: lines("UNKNOWN") },
  blockers: lines("BLOCKERS"),
  availableOptKiB: Number(process.env.OPT_AVAILABLE_KB),
  checkedAt: new Date().toISOString(),
  validUntil: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
NODE
