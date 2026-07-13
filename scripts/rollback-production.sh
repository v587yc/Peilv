#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

usage='Usage: rollback-production.sh <target-release-id> <expected-current-release-id> <request-id> <reason-b64url>'
target_release_id="${1:?$usage}"
expected_current_release_id="${2:?$usage}"
request_id="${3:?$usage}"
reason_b64url="${4:?$usage}"

release_pattern='^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$'
if [[ ! "$target_release_id" =~ $release_pattern ]] || [[ ! "$expected_current_release_id" =~ $release_pattern ]] ||
   [[ "$target_release_id" == "$expected_current_release_id" ]] ||
   [[ ! "$request_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
   [[ ! "$reason_b64url" =~ ^[A-Za-z0-9_-]{4,700}$ ]]; then
  printf 'Invalid rollback arguments\n' >&2
  exit 1
fi

base=/opt/peilv
target="$base/releases/$target_release_id"
current="$(readlink -f "$base/current" 2>/dev/null || true)"
current_id="${current##*/}"
[[ "$current_id" == "$expected_current_release_id" ]] || { printf 'Current release changed since approval\n' >&2; exit 1; }
[[ -d "$target" && -d "$current" && -f "$target/release-manifest.json" && -f "$current/release-manifest.json" ]]

exec 9>/run/lock/peilv-deploy.lock
flock -n 9 || { printf 'Another server-side deployment is running\n' >&2; exit 1; }
[[ "$(readlink -f "$base/current")" == "$current" ]] || { printf 'Current release changed after lock acquisition\n' >&2; exit 1; }

mapfile -t applied_versions < <(docker exec local-data-postgres-1 sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select version from schema_migrations order by applied_at, version;"')
CURRENT_MANIFEST="$current/release-manifest.json" TARGET_MANIFEST="$target/release-manifest.json" APPLIED="$(printf '%s\n' "${applied_versions[@]}")" node <<'NODE'
const fs = require("node:fs");
const current = JSON.parse(fs.readFileSync(process.env.CURRENT_MANIFEST, "utf8"));
const target = JSON.parse(fs.readFileSync(process.env.TARGET_MANIFEST, "utf8"));
const release = /^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/;
if (current.schemaVersion !== 1 || target.schemaVersion !== 1 || !release.test(current.releaseId) || !release.test(target.releaseId)) throw new Error("Invalid release manifest");
const currentByVersion = new Map(current.migrations.map(x => [x.version, x]));
const targetByVersion = new Map(target.migrations.map(x => [x.version, x]));
const known = new Set([...currentByVersion.keys(), ...targetByVersion.keys()]);
const applied = new Set((process.env.APPLIED || "").split("\n").filter(Boolean).map(x => x === "0001_canonical_baseline" ? "0001_production_baseline" : x));
for (const version of applied) if (!known.has(version)) throw new Error(`Unknown database migration: ${version}`);
for (const [version, migration] of targetByVersion) {
  const existing = currentByVersion.get(version);
  if (!existing || existing.sha256 !== migration.sha256) throw new Error(`Migration conflict: ${version}`);
  if (!applied.has(version)) throw new Error(`Target migration is not applied: ${version}`);
}
for (const [version, migration] of currentByVersion) {
  if (!targetByVersion.has(version) && migration.codeRollbackSafe !== true) throw new Error(`Unsafe code rollback migration: ${version}`);
}
NODE

candidate_unit="peilv-candidate-$target_release_id.service"
timers_stopped=0
app_stopped=0
switched=0
completed=0
wait_for_inactive() {
  local unit="$1"
  for _ in {1..150}; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    [[ "$state" != active && "$state" != activating && "$state" != deactivating ]] && return 0
    sleep 2
  done
  return 1
}
stop_candidate() {
  systemctl stop "$candidate_unit" >/dev/null 2>&1 || true
  systemctl reset-failed "$candidate_unit" >/dev/null 2>&1 || true
}
check_application() {
  local port="$1" response
  curl -fsS "http://127.0.0.1:$port/" >/dev/null
  curl -fsS "http://127.0.0.1:$port/odds" >/dev/null
  response="$(set -a; . "$base/shared/app.env"; set +a; curl -fsS -H "x-internal-api-secret: $INTERNAL_API_SECRET" "http://127.0.0.1:$port/api/storage/health")"
  RESPONSE="$response" node -e 'if (JSON.parse(process.env.RESPONSE).success !== true) process.exit(1)'
}
restore_on_failure() {
  status=$?
  stop_candidate
  if (( completed == 0 )); then
    if (( switched == 1 )); then
      ln -s "$current" "$base/current.rollback"
      mv -Tf "$base/current.rollback" "$base/current"
    fi
    if (( app_stopped == 1 )); then systemctl restart peilv.service || true; fi
    if (( timers_stopped == 1 )); then systemctl start peilv-reconcile.timer peilv-dispatch.timer || true; fi
    printf 'Code rollback failed; database was not changed\n' >&2
  fi
  exit "$status"
}
trap restore_on_failure EXIT

check_application 5000
systemctl stop peilv-dispatch.timer peilv-reconcile.timer
timers_stopped=1
wait_for_inactive peilv-dispatch.service
wait_for_inactive peilv-reconcile.service
systemctl stop peilv.service
app_stopped=1

candidate_started_at="$(date --iso-8601=seconds)"
systemd-run --unit="$candidate_unit" --uid=peilv --gid=peilv --working-directory="$target" \
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
  printf 'Rollback candidate log contains an error\n' >&2
  exit 1
fi
stop_candidate

[[ "$(readlink -f "$base/current")" == "$current" ]]
ln -s "$target" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
switched=1
systemctl start peilv.service
for _ in {1..30}; do
  curl -fsS http://127.0.0.1:5000/ >/dev/null 2>&1 && break
  systemctl is-failed --quiet peilv.service && break
  sleep 1
done
[[ "$(readlink -f "$base/current")" == "$target" ]]
[[ "$(systemctl is-active peilv.service)" == active ]]
check_application 5000
systemctl start peilv-reconcile.service
[[ "$(systemctl show peilv-reconcile.service -p Result --value)" == success ]]
systemctl start peilv-reconcile.timer
systemctl start peilv-dispatch.service
[[ "$(systemctl show peilv-dispatch.service -p Result --value)" == success ]]
systemctl start peilv-dispatch.timer
completed=1

RESULT_PATH="/tmp/rollback-$request_id.json" TARGET="$target_release_id" PREVIOUS="$current_id" REQUEST_ID="$request_id" node <<'NODE'
const result = { schemaVersion: 1, status: "succeeded", requestId: process.env.REQUEST_ID, targetReleaseId: process.env.TARGET, previousReleaseId: process.env.PREVIOUS, databaseRestored: false, migrationsRun: false, completedAt: new Date().toISOString() };
require("node:fs").writeFileSync(process.env.RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
NODE
printf 'Code-only rollback completed\nTarget release: %s\nPrevious release: %s\nDatabase restored: no\nMigrations run: no\n' "$target_release_id" "$current_id"
