#!/usr/bin/env bash
set -Eeuo pipefail

release_id="${1:?Usage: production-preflight.sh <release-id> <migration-csv>}"
migration_csv="${2:-}"

if [[ ! "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf 'Invalid release ID\n' >&2
  exit 1
fi
if [[ -n "$migration_csv" && ! "$migration_csv" =~ ^[0-9A-Za-z._-]+\.sql(=[0-9A-Za-z._-]+)?(,[0-9A-Za-z._-]+\.sql(=[0-9A-Za-z._-]+)?)*$ ]]; then
  printf 'Invalid migration list\n' >&2
  exit 1
fi

current_release="$(readlink -f /opt/peilv/current)"
if [[ -z "$current_release" || ! -d "$current_release" ]]; then
  printf 'Current release is invalid\n' >&2
  exit 1
fi

target_release="/opt/peilv/releases/$release_id"
backup_path="/opt/peilv/backups/peilv-before-$release_id.dump"
if [[ -e "$target_release" || -e "$backup_path" ]]; then
  printf 'Target release or backup already exists\n' >&2
  exit 1
fi

for unit in peilv.service peilv-dispatch.timer peilv-reconcile.timer; do
  if [[ "$(systemctl is-active "$unit")" != active ]]; then
    printf 'Required unit is not active: %s\n' "$unit" >&2
    exit 1
  fi
done

if systemctl list-jobs --no-legend --no-pager | grep -Eq 'peilv-(dispatch|reconcile|service)'; then
  printf 'A peilv systemd job is currently running\n' >&2
  exit 1
fi

for mount in / /opt; do
  available_kb="$(df -Pk "$mount" | awk 'NR == 2 { print $4 }')"
  if (( available_kb < 2097152 )); then
    printf 'Less than 2 GiB is available under %s\n' "$mount" >&2
    exit 1
  fi
  [[ "$mount" == /opt ]] && opt_available_kb="$available_kb"
done

ss -lntp | grep -Eq '[:.]5000[[:space:]]'
docker inspect -f '{{.State.Running}}' local-data-postgres-1 local-data-postgrest-1 local-data-gateway-1 | grep -vx true && {
  printf 'A required data container is not running\n' >&2
  exit 1
}

mapfile -t applied_versions < <(
  docker exec local-data-postgres-1 sh -lc \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select version from schema_migrations order by applied_at, version;"'
)

pending=()
if [[ -n "$migration_csv" ]]; then
  IFS=',' read -r -a migration_files <<<"$migration_csv"
  for migration_entry in "${migration_files[@]}"; do
    migration="${migration_entry%%=*}"
    version="${migration_entry#*=}"
    if [[ "$version" == "$migration_entry" ]]; then
      version="${migration%.sql}"
    fi
    aliases=("$version")
    if [[ "$migration" == "0001_production_baseline.sql" ]]; then
      aliases+=("0001_canonical_baseline")
    fi
    found=0
    for alias in "${aliases[@]}"; do
      if printf '%s\n' "${applied_versions[@]}" | grep -Fxq "$alias"; then
        found=1
        break
      fi
    done
    if (( found == 0 )); then
      pending+=("$migration")
    fi
  done
fi

env_owner="$(stat -c '%U' /opt/peilv/shared/app.env)"
env_mode="$(stat -c '%a' /opt/peilv/shared/app.env)"
if [[ "$env_owner" != root ]] || (( (8#$env_mode & 022) != 0 )); then
  printf 'Shared environment file ownership or mode is unsafe\n' >&2
  exit 1
fi

(
  set -a
  . /opt/peilv/shared/app.env
  set +a
  curl -fsS -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
    http://127.0.0.1:5000/api/storage/health >/dev/null
)

printf '## Production preflight\n\n'
printf -- '- New release: `%s`\n' "$target_release"
printf -- '- Current release: `%s`\n' "$current_release"
printf -- '- Code rollback: `%s`\n' "$current_release"
printf -- '- Database backup: `%s`\n' "$backup_path"
printf -- '- Pending migrations: `%s`\n' "${pending[*]:-none}"
printf -- '- Affected units: `peilv.service`, `peilv-dispatch.timer`, `peilv-reconcile.timer`\n'
printf -- '- Expected downtime: `2-5 minutes`\n'
printf -- '- Available /opt space: `%s KiB`\n' "$opt_available_kb"
