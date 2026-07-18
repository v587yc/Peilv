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
transaction_state=/var/lib/peilv/deploy-transaction.json
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
candidate_stage_helper=/usr/local/libexec/peilv/candidate-stage.sh
candidate_lifecycle_helper=/usr/local/libexec/peilv/candidate-lifecycle.sh
deployment_budget_helper=/usr/local/libexec/peilv/deployment-budget.sh
candidate_stage_root=/var/lib/peilv/candidate-stage
candidate_stage="$candidate_stage_root/$target_release_id"
candidate_mount=/srv/peilv-candidate
timers_stopped=0
app_stopped=0
switched=0
completed=0
transaction_started=0
candidate_lifecycle_proven=0
candidate_started=0
original_app_state="$(systemctl is-active peilv.service 2>/dev/null || true)"
original_reconcile_timer_state="$(systemctl is-active peilv-reconcile.timer 2>/dev/null || true)"
original_dispatch_timer_state="$(systemctl is-active peilv-dispatch.timer 2>/dev/null || true)"
openresty_config=/etc/openresty/conf.d/peilv.conf
target_openresty="$target/infra/openresty/peilv.conf"
openresty_backup=""
openresty_changed=0
curl_secret_helper_dir=/usr/local/libexec/peilv
curl_secret_helper="$curl_secret_helper_dir/curl-secret.sh"
trusted_helper_sha_file=/etc/peilv/trusted-curl-secret.sha256
trusted_verifier_sha_file=/etc/peilv/trusted-release-verifier.sha256
trusted_verifier_helper=/usr/local/libexec/peilv/trusted-release-verifier.sh
systemd_units_transaction_started=0
systemd_units=(peilv.service peilv-reconcile.service peilv-reconcile.timer peilv-dispatch.service peilv-dispatch.timer)
systemd_stage_dir="/run/peilv-systemd-stage/rollback-$target_release_id"
systemd_backup_dir="/var/lib/peilv/systemd-transactions/rollback-$target_release_id"
internal_secret_file="$base/shared/credentials/internal-api-secret"
temp_files=()
register_temp_file() { temp_files+=("$1"); }
cleanup_temp_files() { local path; for path in "${temp_files[@]:-}"; do [[ -z "$path" ]] && continue; if [[ -d "$path" && ! -L "$path" ]]; then rm -rf --one-file-system -- "$path"; else rm -f -- "$path"; fi; done; }
validate_unit_state() { local unit="$1" state="$2"; case "$state" in active|inactive|failed|not-found) return 0;; *) printf 'Unsafe or indeterminate systemd state for %s: %s\n' "$unit" "${state:-<empty>}" >&2; return 1;; esac; }
restore_unit_state() {
  local unit="$1" expected="$2" actual
  case "$expected" in active) systemctl start "$unit" || return 1;; inactive) systemctl stop "$unit" || return 1;; failed|not-found) printf 'Refusing to synthesize original %s state for %s\n' "$expected" "$unit" >&2; return 1;; *) validate_unit_state "$unit" "$expected" || return 1;; esac
  actual="$(systemctl is-active "$unit" 2>/dev/null || true)"; validate_unit_state "$unit" "$actual" || return 1
  [[ "$actual" == "$expected" ]] || { printf 'Failed to restore %s to %s (actual: %s)\n' "$unit" "$expected" "$actual" >&2; return 1; }
}
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
write_transaction_state() {
  local stage="$1"
  install -d -o root -g root -m 0700 "$(dirname "$transaction_state")"
  TX_PATH="$transaction_state" TX_STAGE="$stage" TX_RELEASE="$target_release_id" TX_PREVIOUS="$current_id" node <<'NODE'
const fs=require("node:fs");const path=process.env.TX_PATH;const temp=`${path}.next`;
const fd=fs.openSync(temp,"w",0o600);try{fs.writeFileSync(fd,JSON.stringify({schemaVersion:1,operation:"rollback",stage:process.env.TX_STAGE,releaseId:process.env.TX_RELEASE,previousReleaseId:process.env.TX_PREVIOUS,updatedAt:new Date().toISOString()})+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd)}
fs.renameSync(temp,path);const dir=fs.openSync(require("node:path").dirname(path),"r");try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
NODE
}
verify_installed_curl_secret_helper() {
  local expected
  [[ -f "$curl_secret_helper" && ! -L "$curl_secret_helper" && "$(stat -c '%U:%G:%a' "$curl_secret_helper")" == root:root:755 ]]
  [[ -f "$trusted_helper_sha_file" && ! -L "$trusted_helper_sha_file" && "$(stat -c '%U:%G:%a' "$trusted_helper_sha_file")" == root:root:644 ]]
  expected="$(awk 'NR==1{print $1}' "$trusted_helper_sha_file")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$(sha256sum "$curl_secret_helper" | awk '{print $1}')" == "$expected" ]]
}
verify_installed_release_verifier() {
  [[ -f "$trusted_verifier_helper" && ! -L "$trusted_verifier_helper" && "$(stat -c '%U:%G:%a:%h' "$trusted_verifier_helper")" == root:root:755:1 ]] || return 1
  "$trusted_verifier_helper" "$trusted_verifier_sha_file" /usr/local/libexec/peilv
}
stage_release_systemd_units() {
  local release="$1" unit source staged
  rm -rf -- "$systemd_stage_dir"
  install -d -o root -g root -m 0700 "$systemd_stage_dir" "$systemd_backup_dir"
  : >"$systemd_backup_dir/present"
  for unit in "${systemd_units[@]}"; do
    source="$release/infra/systemd/$unit"; [[ -f "$source" && ! -L "$source" ]]
    staged="$systemd_stage_dir/$unit"; install -o root -g root -m 0644 "$source" "$staged"
    [[ "$(sha256sum "$staged" | awk '{print $1}')" == "$(sha256sum "$source" | awk '{print $1}')" ]]
    if [[ -f "/etc/systemd/system/$unit" && ! -L "/etc/systemd/system/$unit" ]]; then cp -a "/etc/systemd/system/$unit" "$systemd_backup_dir/$unit"; printf '%s\n' "$unit" >>"$systemd_backup_dir/present"; fi
  done
  systemd-analyze verify "${systemd_units[@]/#/$systemd_stage_dir/}"
  sync -f "$systemd_backup_dir/present"; sync -d "$systemd_backup_dir"
}
commit_staged_systemd_units() {
  local unit temporary
  systemd_units_transaction_started=1
  write_transaction_state systemd_units_replacing
  for unit in "${systemd_units[@]}"; do temporary="/etc/systemd/system/.${unit}.rollback.next"; install -o root -g root -m 0644 "$systemd_stage_dir/$unit" "$temporary"; mv -Tf "$temporary" "/etc/systemd/system/$unit"; done
  systemctl daemon-reload
  for unit in "${systemd_units[@]}"; do [[ "$(sha256sum "/etc/systemd/system/$unit" | awk '{print $1}')" == "$(sha256sum "$systemd_stage_dir/$unit" | awk '{print $1}')" ]]; done
}
restore_systemd_units_backup() {
  local unit temporary
  [[ -d "$systemd_backup_dir" && -f "$systemd_backup_dir/present" ]] || return 1
  for unit in "${systemd_units[@]}"; do
    if grep -Fxq "$unit" "$systemd_backup_dir/present"; then temporary="/etc/systemd/system/.${unit}.restore"; install -o root -g root -m 0644 "$systemd_backup_dir/$unit" "$temporary"; mv -Tf "$temporary" "/etc/systemd/system/$unit"; else rm -f -- "/etc/systemd/system/$unit"; fi
  done
  systemctl daemon-reload
}
read_env_value() {
  local key="$1" line
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$base/shared/app.env" | tail -n 1 || true)"
  line="${line#*=}"; line="${line%$'\r'}"
  if [[ "$line" == \"*\" && "$line" == *\" ]]; then line="${line:1:${#line}-2}"; elif [[ "$line" == \'*\' && "$line" == *\' ]]; then line="${line:1:${#line}-2}"; fi
  printf '%s' "$line"
}
render_openresty_template() {
  local template="$1" output="$2" host="$3"
  [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] && [[ "$host" != *..* ]] &&
  grep -q '__PEILV_PUBLIC_HOST__' "$template" && ! grep -q '\$host' "$template" &&
  sed "s/__PEILV_PUBLIC_HOST__/$host/g" "$template" >"$output" && ! grep -q '__PEILV_PUBLIC_HOST__' "$output"
}
wait_for_inactive() {
  local unit="$1" state
  for _ in {1..150}; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    case "$state" in
      inactive) return 0 ;;
      active|activating|deactivating) sleep 2 ;;
      *) printf 'Unsafe or indeterminate systemd state while waiting for %s: %s\n' "$unit" "${state:-<empty>}" >&2; return 1 ;;
    esac
  done
  return 1
}
stop_candidate() {
  if (( candidate_started == 0 )); then
    if [[ -e "$candidate_stage" && -d "$candidate_stage_root" && ! -L "$candidate_stage_root" ]] && declare -F candidate_cleanup_stage >/dev/null; then candidate_cleanup_stage "$target_release_id"; fi
    return 0
  fi
  candidate_stop_and_release "$candidate_unit" "$target_release_id" "$candidate_mount" || {
    printf 'Candidate exit or namespace release could not be proven; preserving %s\n' "$candidate_stage" >&2
    return 1
  }
  candidate_lifecycle_proven=1
  if [[ -d "$candidate_stage_root" && ! -L "$candidate_stage_root" ]]; then candidate_cleanup_stage "$target_release_id"; fi
}
check_candidate_application() {
  local port="$1"
  [[ "$port" == 5001 ]]
  candidate_probe "$candidate_unit" "$target_release_id" "$port"
}
rollback_candidate_pretransaction() {
  candidate_stage="$(candidate_prepare_stage "$target" "$target_release_id" /usr/local/libexec/peilv/verify-release.sh)" || return 1
  /usr/local/libexec/peilv/verify-release.sh --tree "$candidate_stage" >/dev/null || return 1
  candidate_started_at="$(date --iso-8601=seconds)" || return 1
  candidate_start "$candidate_unit" "$target_release_id" "$candidate_stage" "$candidate_mount" || return 1
  candidate_started=1
  candidate_pin_netns "$candidate_unit" "$target_release_id" >/dev/null || return 1
  candidate_wait_ready "$candidate_unit" "$target_release_id" || return 1
  check_candidate_application 5001 || return 1
  if journalctl -u "$candidate_unit" --since "$candidate_started_at" --no-pager | grep -Eiq '(error|exception|fatal)'; then
    printf 'Rollback candidate log contains an error\n' >&2
    return 1
  fi
  stop_candidate || return 1
}
check_loopback_application() {
  local port="$1" response
  curl -fsS "http://127.0.0.1:$port/" >/dev/null
  curl -fsS "http://127.0.0.1:$port/login" >/dev/null
  response="$(curl -fsS "http://127.0.0.1:$port/api/readiness")"
  RESPONSE="$response" node -e 'const value=JSON.parse(process.env.RESPONSE);if(value.ready!==true||Object.keys(value).length!==1)process.exit(1)'
}
check_formal_application() {
  local port="$1" probe_unit="peilv-health-probe-$$-$RANDOM.service"
  check_loopback_application "$port"
  systemd-run --quiet --wait --collect --pipe --unit="$probe_unit" --uid=peilv-probe --gid=peilv \
    --property="LoadCredential=internal-api-secret:$internal_secret_file" \
    --property="RuntimeDirectory=peilv-probe" --property="RuntimeDirectoryMode=0700" \
    --property="NoNewPrivileges=true" --property="PrivateDevices=true" --property="ProtectSystem=strict" \
    --property="ProtectHome=true" --property="ProtectProc=invisible" --property="ProcSubset=pid" \
    --property="RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
    /bin/sh -c 'printf '\''url = "http://127.0.0.1:'"$port"'/api/storage/health"\nfail\nsilent\nshow-error\n'\'' | /usr/local/libexec/peilv/curl-secret.sh "$CREDENTIALS_DIRECTORY/internal-api-secret" >/dev/null'
}
check_https_edge() {
  local public_host headers redirect
  public_host="$(read_env_value PEILV_PUBLIC_HOST)"
  redirect="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "$public_host:80:127.0.0.1" "http://$public_host/api/auth/session")"
  [[ "$redirect" == "301 https://$public_host/api/auth/session" ]]
  headers="$(mktemp)"
  register_temp_file "$headers"
  curl -fsS -o /dev/null -D "$headers" --resolve "$public_host:443:127.0.0.1" "https://$public_host/api/auth/session"
  awk 'BEGIN{IGNORECASE=1; bad=0} /^Set-Cookie:/ && $0 !~ /;[[:space:]]*Secure([;[:space:]]|$)/ {bad=1} END{exit bad}' "$headers"
  : >"$headers"
  printf 'url = "https://%s/api/storage/health"\noutput = "/dev/null"\ndump-header = "%s"\nresolve = "%s:443:127.0.0.1"\nfail\nsilent\nshow-error\n' "$public_host" "$headers" "$public_host" | "$curl_secret_helper" "$internal_secret_file"
  awk 'BEGIN{IGNORECASE=1; bad=0} /^Set-Cookie:/ && $0 !~ /;[[:space:]]*Secure([;[:space:]]|$)/ {bad=1} END{exit bad}' "$headers"
  : >"$headers"
  curl -fsS -o /dev/null -D "$headers" --resolve "$public_host:443:127.0.0.1" "https://$public_host/_ops/secure-cookie-probe"
  awk 'BEGIN{IGNORECASE=1; found=0} /^Set-Cookie:/ { if ($0 ~ /;[[:space:]]*Secure([;[:space:]]|$)/) found=1 } END{exit found?0:1}' "$headers"
  rm -f "$headers"
}
restore_on_failure() {
  status=$?
  stop_candidate || status=1
  if (( completed == 0 )); then
    if (( transaction_started == 0 )); then cleanup_temp_files; exit "$status"; fi
    [[ -z "${rendered_openresty:-}" ]] || rm -f "$rendered_openresty"
    # Restore in traffic-safe order: stop target app, restore code pointer, then proxy, then old app.
    systemctl stop peilv.service
    if (( switched == 1 )); then
      rm -f "$base/current.rollback"
      ln -s "$current" "$base/current.rollback"
      mv -Tf "$base/current.rollback" "$base/current"
    fi
    if (( openresty_changed == 1 )); then
      if [[ -n "$openresty_backup" && -f "$openresty_backup" ]]; then
        install -D -o root -g root -m 0644 "$openresty_backup" "$openresty_config"
      else
        rm -f "$openresty_config"
      fi
      openresty -t -q && systemctl reload openresty.service || true
    fi
    if (( systemd_units_transaction_started == 1 )) && ! restore_systemd_units_backup; then printf 'Systemd unit restore failed; preserve %s for manual recovery\n' "$systemd_backup_dir" >&2; status=1; fi
    if ! restore_unit_state peilv.service "$original_app_state"; then printf 'Application state restoration failed\n' >&2; status=1
    elif [[ "$original_app_state" == "active" ]]; then check_formal_application 5000 >/dev/null 2>&1 || status=1; check_https_edge >/dev/null 2>&1 || status=1
    fi
    if (( timers_stopped == 1 )); then
      restore_unit_state peilv-reconcile.timer "$original_reconcile_timer_state" || { printf 'Reconcile timer state restoration failed\n' >&2; status=1; }
      restore_unit_state peilv-dispatch.timer "$original_dispatch_timer_state" || { printf 'Dispatch timer state restoration failed\n' >&2; status=1; }
    fi
    printf 'Code rollback failed; database was not changed\n' >&2
  fi
  cleanup_temp_files
  exit "$status"
}
trap restore_on_failure EXIT

validate_unit_state peilv.service "$original_app_state"
validate_unit_state peilv-reconcile.timer "$original_reconcile_timer_state"
validate_unit_state peilv-dispatch.timer "$original_dispatch_timer_state"
[[ "$original_app_state" == "active" || "$original_app_state" == "inactive" ]] || { printf 'Application must be active or inactive before rollback\n' >&2; exit 1; }
[[ "$original_reconcile_timer_state" == "active" || "$original_reconcile_timer_state" == "inactive" ]] || { printf 'Reconcile timer must be active or inactive before rollback\n' >&2; exit 1; }
[[ "$original_dispatch_timer_state" == "active" || "$original_dispatch_timer_state" == "inactive" ]] || { printf 'Dispatch timer must be active or inactive before rollback\n' >&2; exit 1; }

[[ ! -e "$transaction_state" ]] || { printf 'Unfinished deployment transaction blocks rollback. Dry-run recovery: inspect %s and restore the recorded systemd/OpenResty/current backups before removing the WAL.\n' "$transaction_state" >&2; exit 1; }
verify_installed_curl_secret_helper
verify_installed_release_verifier
[[ -f "$candidate_stage_helper" && ! -L "$candidate_stage_helper" && "$(stat -c '%U:%G:%a:%h' "$candidate_stage_helper")" == root:root:755:1 ]]
# shellcheck source=/usr/local/libexec/peilv/candidate-stage.sh
source "$candidate_stage_helper"
source "$candidate_lifecycle_helper"
source "$deployment_budget_helper"
[[ "$CANDIDATE_STAGE_ROOT" == "$candidate_stage_root" ]]
/usr/local/libexec/peilv/verify-release.sh --tree "$current" --root-owned >/dev/null
/usr/local/libexec/peilv/verify-release.sh --tree "$target" --root-owned >/dev/null
target_kib="$(du -sk -- "$target" | awk 'NR==1{print $1}')"
target_inodes="$(find -P "$target" -xdev -printf . | wc -c)"
deployment_budget_reset
deployment_budget_add "$candidate_stage" "$target_kib" "$target_inodes" candidate_tree
deployment_budget_add "$systemd_backup_dir" "$DEPLOYMENT_SYSTEMD_KIB" 32 systemd_transaction
deployment_budget_check
check_formal_application 5000
[[ -f "$target_openresty" ]]
public_host="$(read_env_value PEILV_PUBLIC_HOST)"
rendered_openresty="$(mktemp)"
register_temp_file "$rendered_openresty"
render_openresty_template "$target_openresty" "$rendered_openresty" "$public_host"
openresty_backup="$(mktemp)"
register_temp_file "$openresty_backup"
if [[ -f "$openresty_config" ]]; then cp -a "$openresty_config" "$openresty_backup"; else rm -f "$openresty_backup"; fi

rollback_candidate_pretransaction

# Target candidate passed without credentials. Enter the trusted rollback transaction now.
/usr/local/libexec/peilv/verify-release.sh --tree "$target" --root-owned >/dev/null
write_transaction_state maintenance_entering
transaction_started=1
systemctl stop peilv-dispatch.timer peilv-reconcile.timer
timers_stopped=1
wait_for_inactive peilv-dispatch.service
wait_for_inactive peilv-reconcile.service
systemctl stop peilv.service
app_stopped=1
write_transaction_state proxy_replacing
openresty_changed=1
install -D -o root -g root -m 0644 "$rendered_openresty" "$openresty_config"
openresty -t -q
systemctl reload openresty.service
[[ "$(sha256sum "$openresty_config" | awk '{print $1}')" == "$(sha256sum "$rendered_openresty" | awk '{print $1}')" ]]
stage_release_systemd_units "$target"
systemd_units_transaction_started=1
commit_staged_systemd_units

[[ "$(readlink -f "$base/current")" == "$current" ]]
/usr/local/libexec/peilv/verify-release.sh --tree "$target" --root-owned >/dev/null
write_transaction_state symlink_switching
ln -s "$target" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
switched=1
[[ "$original_app_state" == "active" ]] && systemctl start peilv.service
for _ in {1..30}; do
  curl -fsS http://127.0.0.1:5000/ >/dev/null 2>&1 && break
  systemctl is-failed --quiet peilv.service && break
  sleep 1
done
[[ "$(readlink -f "$base/current")" == "$target" ]]
if [[ "$original_app_state" == "active" ]]; then
  [[ "$(systemctl is-active peilv.service)" == "active" ]]
  check_formal_application 5000
  check_https_edge
fi
if [[ "$original_reconcile_timer_state" == "active" ]]; then systemctl start peilv-reconcile.service; [[ "$(systemctl show peilv-reconcile.service -p Result --value)" == "success" ]]; systemctl start peilv-reconcile.timer; fi
if [[ "$original_dispatch_timer_state" == "active" ]]; then systemctl start peilv-dispatch.service; [[ "$(systemctl show peilv-dispatch.service -p Result --value)" == "success" ]]; systemctl start peilv-dispatch.timer; fi
LEDGER_PATH="$base/deployment-ledger.json" RELEASE_ID="$target_release_id" PREVIOUS_RELEASE="$current_id" REQUEST_ID="$request_id" node <<'NODE'
const fs = require("node:fs");
const path = process.env.LEDGER_PATH;
let ledger = { schemaVersion: 1, events: [] };
try { ledger = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.events)) throw new Error("Invalid deployment ledger");
ledger.events.push({ kind: "rollback", releaseId: process.env.RELEASE_ID, previousReleaseId: process.env.PREVIOUS_RELEASE, requestId: process.env.REQUEST_ID, completedAt: new Date().toISOString() });
ledger.events = ledger.events.slice(-100);
const temporary = `${path}.next`;
fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o640 });
fs.renameSync(temporary, path);
NODE
completed=1
rm -f "$transaction_state"
[[ -z "$openresty_backup" ]] || rm -f "$openresty_backup"
rm -f "$rendered_openresty"

RESULT_PATH="/tmp/rollback-$request_id.json" TARGET="$target_release_id" PREVIOUS="$current_id" REQUEST_ID="$request_id" node <<'NODE'
const result = { schemaVersion: 1, status: "succeeded", requestId: process.env.REQUEST_ID, targetReleaseId: process.env.TARGET, previousReleaseId: process.env.PREVIOUS, databaseRestored: false, migrationsRun: false, completedAt: new Date().toISOString() };
require("node:fs").writeFileSync(process.env.RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
NODE
printf 'Code-only rollback completed\nTarget release: %s\nPrevious release: %s\nDatabase restored: no\nMigrations run: no\n' "$target_release_id" "$current_id"
