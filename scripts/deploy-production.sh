#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

usage='Usage: deploy-production.sh <release-id> <sha256> <expected-current-release-id> <request-id>'
release_id="${1:?$usage}"
expected_sha="${2:?$usage}"
expected_current_release_id="${3:?$usage}"
request_id="${4:?$usage}"

if [[ ! "$release_id" =~ ^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$ ]] ||
   { [[ ! "$expected_current_release_id" =~ ^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$ ]] &&
     [[ "$expected_current_release_id" != "20260712T192535Z" ]]; }; then
  printf 'Invalid release ID\n' >&2
  exit 1
fi
if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
  printf 'Invalid SHA-256\n' >&2
  exit 1
fi
if [[ ! "$request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  printf 'Invalid request ID\n' >&2
  exit 1
fi

exec 9>/run/lock/peilv-deploy.lock
if ! flock -n 9; then
  printf 'Another server-side deployment is running\n' >&2
  exit 1
fi

base=/opt/peilv
archive="$base/incoming/peilv-$release_id.tar.gz"
checksum="$archive.sha256"
release_dir="$base/releases/$release_id"
backup="$base/backups/peilv-before-$release_id.dump"
old_release="$(readlink -f "$base/current")"
old_release_id="${old_release##*/}"
if [[ "$old_release_id" != "$expected_current_release_id" ]]; then
  printf 'Current release changed since approval\n' >&2
  exit 1
fi
candidate_unit="peilv-candidate-$release_id.service"
timers_stopped=0
app_stopped=0
switched=0
migration_started=0
migration_completed=0
completed=0

wait_for_inactive() {
  local unit="$1"
  local state
  for _ in {1..150}; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    [[ "$state" != active && "$state" != activating && "$state" != deactivating ]] && return 0
    sleep 2
  done
  printf 'Timed out waiting for %s\n' "$unit" >&2
  return 1
}

stop_candidate() {
  if systemctl cat "$candidate_unit" >/dev/null 2>&1; then
    systemctl stop "$candidate_unit" >/dev/null 2>&1 || true
    for _ in {1..30}; do
      systemctl is-active --quiet "$candidate_unit" || break
      sleep 1
    done
    if systemctl is-active --quiet "$candidate_unit"; then
      systemctl kill --signal=SIGKILL "$candidate_unit" || true
      wait_for_inactive "$candidate_unit" || true
    fi
    systemctl reset-failed "$candidate_unit" >/dev/null 2>&1 || true
  fi
}

check_shared_env() {
  local owner mode
  owner="$(stat -c '%U' "$base/shared/app.env")"
  mode="$(stat -c '%a' "$base/shared/app.env")"
  [[ "$owner" == root ]] && (( (8#$mode & 022) == 0 ))
}

check_application() {
  local port="$1"
  local response
  curl -fsS "http://127.0.0.1:$port/" >/dev/null
  curl -fsS "http://127.0.0.1:$port/odds" >/dev/null
  response="$(
    (
      set -a
      . "$base/shared/app.env"
      set +a
      curl -fsS -H "x-internal-api-secret: $INTERNAL_API_SECRET" \
        "http://127.0.0.1:$port/api/storage/health"
    )
  )"
  RESPONSE="$response" node -e '
    const value = JSON.parse(process.env.RESPONSE);
    if (value.success !== true) process.exit(1);
  '
}

restore_on_failure() {
  status=$?
  stop_candidate

  if (( completed == 0 )); then
    if (( migration_started == 1 && migration_completed == 0 )); then
      printf 'Deployment failed during migration. Application and timers remain stopped for database assessment.\n' >&2
      printf 'Database backup: %s\n' "$backup" >&2
      exit "$status"
    fi

    if (( switched == 1 )); then
      systemctl stop peilv-dispatch.timer peilv-reconcile.timer || true
      wait_for_inactive peilv-dispatch.service || true
      wait_for_inactive peilv-reconcile.service || true
      systemctl stop peilv.service || true
      if [[ -n "$old_release" && -d "$old_release" ]]; then
        rm -f "$base/current.rollback"
        ln -s "$old_release" "$base/current.rollback"
        mv -Tf "$base/current.rollback" "$base/current"
      fi
    fi

    if (( app_stopped == 1 )); then
      systemctl restart peilv.service || true
      if systemctl is-active --quiet peilv.service; then
        curl -fsS http://127.0.0.1:5000/ >/dev/null 2>&1 || true
      fi
    fi
    if (( timers_stopped == 1 )); then
      systemctl start peilv-reconcile.timer peilv-dispatch.timer || true
    fi
    printf 'Deployment failed. Code rollback was attempted; database restoration was not performed.\n' >&2
  fi
  exit "$status"
}
trap restore_on_failure EXIT

[[ -f "$archive" && -f "$checksum" ]]
[[ ! -e "$release_dir" && ! -e "$backup" ]]
[[ -n "$old_release" && -d "$old_release" ]]
[[ "$(node --version)" =~ ^v22\. ]]
[[ "$(pnpm --version)" =~ ^9\. ]]
check_shared_env

checksum_line="$(sed -n '1p' "$checksum")"
checksum_sha="${checksum_line%% *}"
checksum_name="${checksum_line#"$checksum_sha"}"
checksum_name="${checksum_name# }"
checksum_name="${checksum_name# }"
checksum_name="${checksum_name#\*}"
[[ "$checksum_sha" == "$expected_sha" ]]
[[ "$checksum_name" == "peilv-$release_id.tar.gz" ]]
/usr/local/libexec/peilv/verify-release.sh "$archive" "$checksum"

for mount in / /opt; do
  available_kb="$(df -Pk "$mount" | awk 'NR == 2 { print $4 }')"
  (( available_kb >= 2097152 ))
done
for container in local-data-postgres-1 local-data-postgrest-1 local-data-gateway-1; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]]
done
[[ "$(readlink -f "$base/current")" == "$old_release" ]]
check_application 5000

install -d -o peilv -g peilv -m 0750 "$release_dir"
tar -xzf "$archive" -C "$release_dir" --no-same-owner --no-same-permissions
chown -R peilv:peilv "$release_dir"
if find "$release_dir" -type f -iname '.env*' -print -quit | grep -q .; then
  printf 'Release contains an environment file\n' >&2
  exit 1
fi

runuser -u peilv -- sh -lc "cd '$release_dir' && pnpm install --prod --frozen-lockfile"
runuser -u peilv -- sh -lc "cd '$release_dir' && node --check dist/server.js && pnpm list --prod --depth 0 >/dev/null"

[[ "$(readlink -f "$base/current")" == "$old_release" ]]
[[ ! -e "$backup" ]]
for container in local-data-postgres-1 local-data-postgrest-1 local-data-gateway-1; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]]
done
check_application 5000

systemctl stop peilv-dispatch.timer peilv-reconcile.timer
timers_stopped=1
wait_for_inactive peilv-dispatch.service
wait_for_inactive peilv-reconcile.service

systemctl stop peilv.service
app_stopped=1

install -d -o root -g peilv -m 0750 "$base/backups"
docker exec local-data-postgres-1 sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
chmod 0640 "$backup"
test -s "$backup"
docker exec -i local-data-postgres-1 pg_restore -l < "$backup" >/dev/null
backup_sha="$(sha256sum "$backup" | awk '{print $1}')"

mapfile -t migrations < <(find "$release_dir/migrations" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort)
applied=()
for migration in "${migrations[@]}"; do
  version="$(sed -n '/INSERT INTO schema_migrations(version, description)/,/ON CONFLICT/p' "$release_dir/migrations/$migration" | sed -nE "0,/^[[:space:]]*'([^']+)'[[:space:]]*,?[[:space:]]*$/s//\\1/p" | head -n 1)"
  if [[ -z "$version" ]]; then
    printf 'Unable to determine migration version: %s\n' "$migration" >&2
    exit 1
  fi
  aliases=("$version")
  if [[ "$migration" == "0001_production_baseline.sql" ]]; then
    aliases+=("0001_canonical_baseline")
  fi
  already_applied=0
  for alias in "${aliases[@]}"; do
    if docker exec local-data-postgres-1 sh -lc \
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select 1 from schema_migrations where version = '\''$1'\''"' sh "$alias" | grep -Fxq 1; then
      already_applied=1
      break
    fi
  done
  if (( already_applied == 1 )); then
    continue
  fi

  migration_started=1
  docker exec -i local-data-postgres-1 sh -lc \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1' \
    < "$release_dir/migrations/$migration"

  docker exec local-data-postgres-1 sh -lc \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select 1 from schema_migrations where version = '\''$1'\''"' sh "$version" | grep -Fxq 1
  applied+=("$migration")
done
migration_completed=1

docker logs --since 5m local-data-postgrest-1 2>&1 | grep -Eiq '(panic|fatal)' && {
  printf 'PostgREST reported a fatal migration error\n' >&2
  exit 1
}

candidate_started_at="$(date --iso-8601=seconds)"
systemd-run \
  --unit="$candidate_unit" \
  --uid=peilv \
  --gid=peilv \
  --working-directory="$release_dir" \
  --property="EnvironmentFile=$base/shared/app.env" \
  /usr/bin/env PORT=5001 DEPLOY_RUN_PORT=5001 /usr/bin/node dist/server.js >/dev/null

for _ in {1..30}; do
  curl -fsS http://127.0.0.1:5001/ >/dev/null 2>&1 && break
  systemctl is-failed --quiet "$candidate_unit" && break
  sleep 1
done
systemctl is-active --quiet "$candidate_unit"
check_application 5001
if journalctl -u "$candidate_unit" --since "$candidate_started_at" --no-pager | grep -Eiq '(error|exception|fatal)'; then
  printf 'Candidate log contains an error\n' >&2
  exit 1
fi
stop_candidate

ln -s "$release_dir" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
switched=1
systemctl start peilv.service
for _ in {1..30}; do
  curl -fsS http://127.0.0.1:5000/ >/dev/null 2>&1 && break
  systemctl is-failed --quiet peilv.service && break
  sleep 1
done

[[ "$(readlink -f "$base/current")" == "$release_dir" ]]
[[ "$(systemctl is-active peilv.service)" == active ]]
ss -lntp | grep -Eq '[:.]5000[[:space:]]'
check_application 5000

systemctl start peilv-reconcile.service
[[ "$(systemctl show peilv-reconcile.service -p Result --value)" == success ]]
systemctl start peilv-reconcile.timer
systemctl start peilv-dispatch.service
[[ "$(systemctl show peilv-dispatch.service -p Result --value)" == success ]]
systemctl start peilv-dispatch.timer

[[ "$(systemctl is-active peilv-reconcile.timer)" == active ]]
[[ "$(systemctl is-active peilv-dispatch.timer)" == active ]]
completed=1

rm -f "$archive" "$checksum" || printf 'Warning: incoming artifact cleanup failed\n' >&2
RESULT_PATH="/tmp/deployment-$request_id.json" RELEASE_ID="$release_id" PREVIOUS_RELEASE="$old_release_id" BACKUP="$backup" BACKUP_SHA="$backup_sha" APPLIED="$(printf '%s\n' "${applied[@]}")" REQUEST_ID="$request_id" node <<'NODE'
const migrations = (process.env.APPLIED || "").split("\n").filter(Boolean);
const result = {
  schemaVersion: 1,
  status: "succeeded",
  requestId: process.env.REQUEST_ID,
  releaseId: process.env.RELEASE_ID,
  previousReleaseId: process.env.PREVIOUS_RELEASE,
  backupPath: process.env.BACKUP,
  backupSha256: process.env.BACKUP_SHA,
  appliedMigrations: migrations,
  completedAt: new Date().toISOString(),
};
require("node:fs").writeFileSync(process.env.RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
NODE
printf 'Deployment completed\n'
printf 'Release: %s\n' "$release_dir"
printf 'Previous release: %s\n' "$old_release"
printf 'Backup: %s\n' "$backup"
printf 'Backup SHA-256: %s\n' "$backup_sha"
printf 'Applied migrations: %s\n' "${applied[*]:-none}"
