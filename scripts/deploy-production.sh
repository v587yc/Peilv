#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

usage='Usage: deploy-production.sh <release-id> <sha256> <expected-current-release-id> <request-id> [--maintenance-window-confirmed] [--approved-current-unit-hotfix-transition]'
release_id="${1:?$usage}"
expected_sha="${2:?$usage}"
expected_current_release_id="${3:?$usage}"
request_id="${4:?$usage}"
maintenance_confirmation=""
transition_confirmation=""
for option in "${@:5}"; do
  case "$option" in
    --maintenance-window-confirmed) maintenance_confirmation="$option" ;;
    --approved-current-unit-hotfix-transition) transition_confirmation="$option" ;;
    *) printf 'Unknown deployment option: %s\n' "$option" >&2; exit 1 ;;
  esac
done

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
transaction_state=/var/lib/peilv/deploy-transaction.json
archive="$base/incoming/peilv-$release_id.tar.gz"
checksum="$archive.sha256"
verified_incoming_dir=/var/lib/peilv/incoming-verified
private_archive="$verified_incoming_dir/$request_id.tar.gz"
release_dir="$base/releases/$release_id"
[[ ! -e "$release_dir" ]] || { printf 'Release directory already exists\n' >&2; exit 1; }
backup="$base/backups/peilv-before-$release_id.dump"
old_release="$(readlink -f "$base/current")"
old_release_id="${old_release##*/}"
if [[ "$old_release_id" != "$expected_current_release_id" ]]; then
  printf 'Current release changed since approval\n' >&2
  exit 1
fi
candidate_unit="peilv-candidate-$release_id.service"
candidate_stage_helper=/usr/local/libexec/peilv/candidate-stage.sh
candidate_lifecycle_helper=/usr/local/libexec/peilv/candidate-lifecycle.sh
deployment_budget_helper=/usr/local/libexec/peilv/deployment-budget.sh
candidate_stage_root=/var/lib/peilv/candidate-stage
candidate_stage="$candidate_stage_root/$release_id"
candidate_mount=/srv/peilv-candidate
timers_stopped=0
app_stopped=0
switched=0
migration_started=0
migration_completed=0
incompatible_migration_pending=0
incompatible_migration_started=0
completed=0
transaction_started=0
candidate_lifecycle_proven=0
candidate_started=0
release_activated=0
release_created=0
original_app_state="$(systemctl is-active peilv.service 2>/dev/null || true)"
original_reconcile_timer_state="$(systemctl is-active peilv-reconcile.timer 2>/dev/null || true)"
original_dispatch_timer_state="$(systemctl is-active peilv-dispatch.timer 2>/dev/null || true)"
openresty_config=/opt/1panel/www/sites/pb.aixid.cc/proxy/root.conf
openresty_http_config=/opt/1panel/www/conf.d/peilv-http.conf
openresty_control=/usr/local/libexec/peilv/openresty-control
openresty_backup=""
openresty_http_backup=""
openresty_changed=0
curl_secret_helper_dir=/usr/local/libexec/peilv
curl_secret_helper="$curl_secret_helper_dir/curl-secret.sh"
trusted_helper_sha_file=/etc/peilv/trusted-curl-secret.sha256
release_verifier=/usr/local/libexec/peilv/verify-release.sh
private_copy_helper=/usr/local/libexec/peilv/private-copy.mjs
trusted_verifier_sha_file=/etc/peilv/trusted-release-verifier.sha256
trusted_verifier_helper=/usr/local/libexec/peilv/trusted-release-verifier.sh
systemd_units_transaction_started=0
systemd_units=(peilv.service peilv-reconcile.service peilv-reconcile.timer peilv-dispatch.service peilv-dispatch.timer)
systemd_stage_dir="/run/peilv-systemd-stage/$release_id"
systemd_backup_dir="/var/lib/peilv/systemd-transactions/$release_id"
internal_secret_file="$base/shared/credentials/internal-api-secret"
temp_files=()
register_temp_file() { temp_files+=("$1"); }
cleanup_temp_files() { local path; for path in "${temp_files[@]:-}"; do [[ -z "$path" ]] && continue; if [[ -d "$path" && ! -L "$path" ]]; then rm -rf --one-file-system -- "$path"; else rm -f -- "$path"; fi; done; }
validate_unit_state() {
  local unit="$1" state="$2"
  case "$state" in
    active|inactive|failed|not-found) return 0 ;;
    *) printf 'Unsafe or indeterminate systemd state for %s: %s\n' "$unit" "${state:-<empty>}" >&2; return 1 ;;
  esac
}
restore_unit_state() {
  local unit="$1" expected="$2" actual
  case "$expected" in
    active) systemctl start "$unit" || return 1 ;;
    inactive) systemctl stop "$unit" || return 1 ;;
    failed|not-found)
      printf 'Refusing to synthesize original %s state for %s\n' "$expected" "$unit" >&2
      return 1
      ;;
    *) validate_unit_state "$unit" "$expected" || return 1 ;;
  esac
  actual="$(systemctl is-active "$unit" 2>/dev/null || true)"
  validate_unit_state "$unit" "$actual" || return 1
  [[ "$actual" == "$expected" ]] || { printf 'Failed to restore %s to %s (actual: %s)\n' "$unit" "$expected" "$actual" >&2; return 1; }
}
create_probe_runtime() {
  local runtime
  runtime="$(mktemp -d "/run/peilv-deploy-${request_id}-XXXXXXXX")" || return 1
  chmod 0700 -- "$runtime" || { rmdir -- "$runtime"; return 1; }
  [[ ! -L "$runtime" && "$(stat -c '%U:%G:%a' -- "$runtime")" == root:root:700 ]] || { rmdir -- "$runtime"; return 1; }
  printf '%s\n' "$runtime"
}
cleanup_probe_runtime() {
  local runtime="$1"
  [[ "$runtime" == "/run/peilv-deploy-${request_id}-"* && -d "$runtime" && ! -L "$runtime" ]] || return 1
  rm -f -- "$runtime"/curl.* "$runtime"/headers "$runtime"/body
  rmdir -- "$runtime"
}
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
write_transaction_state() {
  local stage="$1"
  install -d -o root -g root -m 0700 "$(dirname "$transaction_state")"
  TX_PATH="$transaction_state" TX_STAGE="$stage" TX_RELEASE="$release_id" TX_PREVIOUS="$old_release_id" node <<'NODE'
const fs=require("node:fs");const path=process.env.TX_PATH;const temp=`${path}.next`;
const fd=fs.openSync(temp,"w",0o600);try{fs.writeFileSync(fd,JSON.stringify({schemaVersion:1,stage:process.env.TX_STAGE,releaseId:process.env.TX_RELEASE,previousReleaseId:process.env.TX_PREVIOUS,updatedAt:new Date().toISOString()})+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd)}
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
verify_app_unit_contract() {
  local unit="$1" key expected
  [[ -f "$unit" && ! -L "$unit" ]] || { printf 'Application systemd unit is missing or unsafe\n' >&2; return 1; }
  for expected in 'HOSTNAME=127.0.0.1' 'PORT=5000' 'DEPLOY_RUN_PORT=5000'; do
    key="${expected%%=*}"
    [[ "$(grep -Ec "^Environment=${key}=" "$unit")" == 1 ]] && grep -Fxq "Environment=$expected" "$unit" || {
      printf 'Application systemd listener contract is missing or invalid: %s\n' "$key" >&2
      return 1
    }
  done
  ! grep -Eq 'Environment=(HOSTNAME=0\.0\.0\.0|PORT=3000|DEPLOY_RUN_PORT=3000)$' "$unit" &&
    grep -Fxq 'ExecStart=/usr/bin/node /opt/peilv/current/server.js' "$unit"
}
verify_installed_app_unit_binding() {
  local installed=/etc/systemd/system/peilv.service current="$old_release/infra/systemd/peilv.service"
  if verify_app_unit_contract "$installed" && verify_app_unit_contract "$current" && cmp -s "$installed" "$current"; then return 0; fi
  approve_current_unit_hotfix_transition "$installed" "$current" || {
    printf 'Installed application systemd unit is missing or drifted from the current release\n' >&2; return 1;
  }
}
approve_current_unit_hotfix_transition() {
  local installed="$1" current="$2" latest_version listeners
  [[ "$transition_confirmation" == --approved-current-unit-hotfix-transition ]] || return 1
  [[ "$expected_current_release_id" == r20260716074436-a1-a8f074c3680f && "$old_release_id" == "$expected_current_release_id" ]] || return 1
  verify_app_unit_contract "$installed" || return 1
  [[ -f "$current" && ! -L "$current" ]] || return 1
  for key in HOSTNAME PORT DEPLOY_RUN_PORT; do [[ "$(grep -Ec "^Environment=${key}=" "$current")" == 0 ]] || return 1; done
  grep -Fxq 'ExecStart=/usr/bin/node /opt/peilv/current/server.js' "$current" || return 1
  CURRENT_UNIT="$current" INSTALLED_UNIT="$installed" node <<'NODE' || return 1
const fs = require("node:fs");
const approved = new Set(["Environment=HOSTNAME=127.0.0.1", "Environment=PORT=5000", "Environment=DEPLOY_RUN_PORT=5000"]);
const current = fs.readFileSync(process.env.CURRENT_UNIT, "utf8").split("\n");
const installed = fs.readFileSync(process.env.INSTALLED_UNIT, "utf8").split("\n");
const found = installed.filter(line => approved.has(line));
if (found.length !== 3 || new Set(found).size !== 3) process.exit(1);
if (installed.filter(line => !approved.has(line)).join("\n") !== current.join("\n")) process.exit(1);
NODE
  latest_version="$(docker exec local-data-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select version from schema_migrations order by version desc limit 1"')"
  [[ "$latest_version" == 0014_admin_login_uniform_reservations ]] || return 1
  listeners="$(ss -lntH 'sport = :5000' 2>/dev/null || true)"
  [[ -n "$listeners" ]] && awk '$4 !~ /^(127\.0\.0\.1|\[::1\]):5000$/ { exit 1 }' <<<"$listeners"
}
stage_release_systemd_units() {
  local release="$1" unit source staged
  verify_app_unit_contract "$release/infra/systemd/peilv.service" || return 1
  rm -rf -- "$systemd_stage_dir"
  install -d -o root -g root -m 0700 "$systemd_stage_dir"
  install -d -o root -g root -m 0700 "$systemd_backup_dir"
  : >"$systemd_backup_dir/present"
  for unit in "${systemd_units[@]}"; do
    source="$release/infra/systemd/$unit"
    [[ -f "$source" && ! -L "$source" ]]
    staged="$systemd_stage_dir/$unit"; install -o root -g root -m 0644 "$source" "$staged"
    [[ "$(sha256sum "$staged" | awk '{print $1}')" == "$(sha256sum "$source" | awk '{print $1}')" ]]
    if [[ -f "/etc/systemd/system/$unit" && ! -L "/etc/systemd/system/$unit" ]]; then
      cp -a "/etc/systemd/system/$unit" "$systemd_backup_dir/$unit"
      printf '%s\n' "$unit" >>"$systemd_backup_dir/present"
    fi
  done
  systemd-analyze verify "${systemd_units[@]/#/$systemd_stage_dir/}"
  sync -f "$systemd_backup_dir/present"
  sync -d "$systemd_backup_dir"
}
commit_staged_systemd_units() {
  local unit temporary
  systemd_units_transaction_started=1
  write_transaction_state systemd_units_replacing
  for unit in "${systemd_units[@]}"; do
    temporary="/etc/systemd/system/.${unit}.${release_id}.next"
    install -o root -g root -m 0644 "$systemd_stage_dir/$unit" "$temporary"
    mv -Tf "$temporary" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  for unit in "${systemd_units[@]}"; do
    [[ "$(sha256sum "/etc/systemd/system/$unit" | awk '{print $1}')" == "$(sha256sum "$systemd_stage_dir/$unit" | awk '{print $1}')" ]]
  done
}
restore_systemd_units_backup() {
  local unit temporary
  [[ -d "$systemd_backup_dir" && -f "$systemd_backup_dir/present" ]] || return 1
  for unit in "${systemd_units[@]}"; do
    if grep -Fxq "$unit" "$systemd_backup_dir/present"; then
      temporary="/etc/systemd/system/.${unit}.${release_id}.restore"
      install -o root -g root -m 0644 "$systemd_backup_dir/$unit" "$temporary"
      mv -Tf "$temporary" "/etc/systemd/system/$unit"
    else
      rm -f -- "/etc/systemd/system/$unit"
    fi
  done
  systemctl daemon-reload
  for unit in "${systemd_units[@]}"; do
    if grep -Fxq "$unit" "$systemd_backup_dir/present"; then
      [[ "$(sha256sum "/etc/systemd/system/$unit" | awk '{print $1}')" == "$(sha256sum "$systemd_backup_dir/$unit" | awk '{print $1}')" ]] || return 1
    else
      [[ ! -e "/etc/systemd/system/$unit" ]] || return 1
    fi
  done
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
  local unit="$1"
  local state
  for _ in {1..150}; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    case "$state" in
      inactive) return 0 ;;
      active|activating|deactivating) sleep 2 ;;
      *) printf 'Unsafe or indeterminate systemd state while waiting for %s: %s\n' "$unit" "${state:-<empty>}" >&2; return 1 ;;
    esac
  done
  printf 'Timed out waiting for %s\n' "$unit" >&2
  return 1
}

stop_candidate() {
  if (( candidate_started == 0 )); then
    if [[ -e "$candidate_stage" && -d "$candidate_stage_root" && ! -L "$candidate_stage_root" ]] && declare -F candidate_cleanup_stage >/dev/null; then candidate_cleanup_stage "$release_id"; fi
    return 0
  fi
  candidate_stop_and_release "$candidate_unit" "$release_id" "$candidate_mount" || {
    printf 'Candidate exit or namespace release could not be proven; preserving %s\n' "$candidate_stage" >&2
    return 1
  }
  candidate_lifecycle_proven=1
  if [[ -d "$candidate_stage_root" && ! -L "$candidate_stage_root" ]]; then candidate_cleanup_stage "$release_id"; fi
}

check_shared_env() {
  local owner mode
  owner="$(stat -c '%U' "$base/shared/app.env")"
  mode="$(stat -c '%a' "$base/shared/app.env")"
  [[ "$owner" == root ]] && (( (8#$mode & 022) == 0 ))
}

check_candidate_application() {
  local port="$1" response
  [[ "$port" == 5001 ]]
  candidate_probe "$candidate_unit" "$release_id" "$port"
}

check_loopback_application() {
  local port="$1" response
  curl -fsS "http://127.0.0.1:$port/" >/dev/null
  curl -fsS "http://127.0.0.1:$port/login" >/dev/null
  response="$(curl -fsS "http://127.0.0.1:$port/api/readiness")"
  RESPONSE="$response" node -e '
    const value = JSON.parse(process.env.RESPONSE);
    if (value.ready !== true || Object.keys(value).length !== 1) process.exit(1);
  '
}

check_formal_application() {
  local port="$1" probe_unit="peilv-health-probe-$$-$RANDOM.service"
  check_loopback_application "$port"
  systemd-run --quiet --wait --collect --pipe --unit="$probe_unit" \
    --uid=peilv-probe --gid=peilv \
    --property="LoadCredential=internal-api-secret:$internal_secret_file" \
    --property="RuntimeDirectory=peilv-probe" --property="RuntimeDirectoryMode=0700" \
    --property="NoNewPrivileges=true" --property="PrivateDevices=true" --property="ProtectSystem=strict" \
    --property="ProtectHome=true" --property="ProtectProc=invisible" --property="ProcSubset=pid" \
    --property="RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
    /bin/sh -c 'printf '\''url = "http://127.0.0.1:'"$port"'/api/storage/health"\nfail\nsilent\nshow-error\n'\'' | /usr/local/libexec/peilv/curl-secret.sh "$CREDENTIALS_DIRECTORY/internal-api-secret" >/dev/null'
}

check_current_application() {
  local port="$1" runtime status=0
  curl -fsS "http://127.0.0.1:$port/" >/dev/null
  curl -fsS "http://127.0.0.1:$port/login" >/dev/null
  runtime="$(create_probe_runtime)"
  register_temp_file "$runtime"
  printf 'url = "http://127.0.0.1:%s/api/storage/health"\nfail\nsilent\nshow-error\noutput = "/dev/null"\n' "$port" | RUNTIME_DIRECTORY="$runtime" "$curl_secret_helper" "$internal_secret_file" >/dev/null || status=$?
  cleanup_probe_runtime "$runtime" || return 1
  return "$status"
}

validate_unauthenticated_session_response() {
  local status="$1" headers="$2" body="$3"
  [[ "$status" == 200 || "$status" == 401 ]] || return 1
  [[ -f "$headers" && ! -L "$headers" && -f "$body" && ! -L "$body" ]] || return 1
  (( $(stat -c '%s' -- "$body") <= 4096 )) || return 1
  ! grep -Eiq '^Set-Cookie:' "$headers" || return 1
  awk 'BEGIN{IGNORECASE=1; found=0} /^Cache-Control:/ {sub(/\r$/,""); value=$0; sub(/^[^:]*:[[:space:]]*/,"",value); count=split(value,tokens,","); for(i=1;i<=count;i++){gsub(/^[[:space:]]+|[[:space:]]+$/, "", tokens[i]); if(tokens[i]=="no-store")found=1}} END{exit found?0:1}' "$headers" || return 1
  awk 'BEGIN{IGNORECASE=1; found=0} /^Content-Type:/ {sub(/\r$/,""); value=$0; sub(/^[^:]*:[[:space:]]*/,"",value); if(value ~ /^application\/json([[:space:]]*;|$)/)found=1} END{exit found?0:1}' "$headers" || return 1
  SESSION_STATUS="$status" SESSION_BODY_FILE="$body" /usr/bin/node <<'NODE'
const fs = require("node:fs");
const status = Number(process.env.SESSION_STATUS);
let value;
try { value = JSON.parse(fs.readFileSync(process.env.SESSION_BODY_FILE, "utf8")); } catch { process.exit(1); }
if (!value || Array.isArray(value) || typeof value !== "object") process.exit(1);
const keys = Object.keys(value).sort();
const exact = expected => { expected.sort(); return keys.length === expected.length && expected.every((key, index) => keys[index] === key); };
if (status === 401) {
  if (!exact(["actorType", "authenticated", "configured"]) || value.configured !== true || value.authenticated !== false || value.actorType !== null) process.exit(1);
} else {
  if (!exact(["actorType", "authenticated", "configured", "initialized", "user"]) ||
      typeof value.configured !== "boolean" || typeof value.initialized !== "boolean" ||
      value.authenticated !== false || value.actorType !== null || value.user !== null) process.exit(1);
}
NODE
}

check_preupgrade_https_edge() {
  local public_host headers body runtime redirect session_status status=0
  public_host="$(read_env_value PEILV_PUBLIC_HOST)"
  redirect="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "$public_host:80:127.0.0.1" "http://$public_host/api/auth/session")"
  [[ "$redirect" == "301 https://$public_host/api/auth/session" ]]
  runtime="$(create_probe_runtime)"
  register_temp_file "$runtime"
  headers="$runtime/headers"; body="$runtime/body"
  install -o root -g root -m 0600 /dev/null "$headers"
  install -o root -g root -m 0600 /dev/null "$body"
  session_status="$(curl -sS -o "$body" -D "$headers" -w '%{http_code}' --resolve "$public_host:443:127.0.0.1" "https://$public_host/api/auth/session")" || status=$?
  if (( status == 0 )); then validate_unauthenticated_session_response "$session_status" "$headers" "$body" || status=$?; fi
  rm -f -- "$body"
  : >"$headers"
  if (( status == 0 )); then
    printf 'url = "https://%s/api/storage/health"\noutput = "/dev/null"\ndump-header = "%s"\nresolve = "%s:443:127.0.0.1"\nfail\nsilent\nshow-error\n' "$public_host" "$headers" "$public_host" | RUNTIME_DIRECTORY="$runtime" "$curl_secret_helper" "$internal_secret_file" >/dev/null || status=$?
  fi
  if (( status == 0 )); then awk 'BEGIN{IGNORECASE=1; bad=0} /^Set-Cookie:/ && $0 !~ /;[[:space:]]*Secure([;[:space:]]|$)/ {bad=1} END{exit bad}' "$headers" || status=$?; fi
  cleanup_probe_runtime "$runtime" || return 1
  return "$status"
}

check_secure_cookie_probe() {
  local public_host headers runtime code status=0
  public_host="$(read_env_value PEILV_PUBLIC_HOST)"
  runtime="$(create_probe_runtime)"; register_temp_file "$runtime"; headers="$runtime/headers"
  install -o root -g root -m 0600 /dev/null "$headers"
  code="$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' --resolve "$public_host:443:127.0.0.1" "https://$public_host/_ops/secure-cookie-probe")" || status=$?
  [[ "$status" == 0 && ( "$code" == 200 || "$code" == 204 ) ]] || status=1
  if (( status == 0 )); then awk 'BEGIN{IGNORECASE=1; found=0} /^Cache-Control:/ {sub(/\r$/,""); value=$0; sub(/^[^:]*:[[:space:]]*/,"",value); count=split(value,tokens,","); for(i=1;i<=count;i++){gsub(/^[[:space:]]+|[[:space:]]+$/, "", tokens[i]); if(tokens[i]=="no-store")found=1}} END{exit found?0:1}' "$headers" || status=$?; fi
  if (( status == 0 )); then awk 'BEGIN{IGNORECASE=1; found=0} /^Set-Cookie:/ {if($0~/;[[:space:]]*Secure([;[:space:]]|$)/&&$0~/;[[:space:]]*HttpOnly([;[:space:]]|$)/&&$0~/;[[:space:]]*SameSite=(Strict|Lax|None)([;[:space:]]|$)/)found=1} END{exit found?0:1}' "$headers" || status=$?; fi
  cleanup_probe_runtime "$runtime" || return 1
  return "$status"
}

quarantine_created_release() {
  if (( release_created == 1 && release_activated == 0 )) && [[ -d "$release_dir" && ! -L "$release_dir" ]]; then
    local quarantine_dir attempt=0
    install -d -o root -g root -m 0700 "$base/quarantine"
    quarantine_dir="$base/quarantine/${release_id}.failed-${request_id}"
    while [[ -e "$quarantine_dir" || -L "$quarantine_dir" ]]; do
      ((attempt += 1))
      quarantine_dir="$base/quarantine/${release_id}.failed-${request_id}.attempt-${attempt}"
    done
    mv -T "$release_dir" "$quarantine_dir"
    chmod 0700 "$quarantine_dir"
    printf '%s\n' "failed-before-activation" >"$quarantine_dir/QUARANTINED"
  fi
}

restore_on_failure() {
  status=$?
  stop_candidate || status=1

  if (( completed == 0 )); then
    quarantine_created_release
    if (( transaction_started == 0 )); then cleanup_temp_files; exit "$status"; fi
    [[ -z "${rendered_openresty:-}" ]] || rm -f "$rendered_openresty"
    if (( openresty_changed == 1 )); then
      if [[ -n "$openresty_backup" && -f "$openresty_backup" ]]; then
        install -D -o root -g root -m 0644 "$openresty_backup" "$openresty_config"
      else
        rm -f "$openresty_config"
      fi
      if [[ -n "$openresty_http_backup" && -f "$openresty_http_backup" ]]; then
        install -D -o root -g root -m 0644 "$openresty_http_backup" "$openresty_http_config"
      else
        rm -f "$openresty_http_config"
      fi
      "$openresty_control" reload || true
    fi
    if (( incompatible_migration_started == 1 )) || (( migration_started == 1 && migration_completed == 0 )); then
      printf 'Deployment failed after a non-rollback-safe or incomplete migration. Application and timers remain stopped for database assessment.\n' >&2
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

    if (( systemd_units_transaction_started == 1 )) && ! restore_systemd_units_backup; then printf 'Systemd unit restore failed; preserve %s for manual recovery\n' "$systemd_backup_dir" >&2; status=1; fi
    if (( app_stopped == 1 )); then
      if ! restore_unit_state peilv.service "$original_app_state"; then printf 'Application state restoration failed\n' >&2; status=1
      elif [[ "$original_app_state" == "active" ]] && ! check_current_application 5000 >/dev/null 2>&1; then printf 'Restored application failed readiness\n' >&2; status=1
      fi
    fi
    if (( timers_stopped == 1 )); then
      if ! restore_unit_state peilv-reconcile.timer "$original_reconcile_timer_state"; then printf 'Reconcile timer state restoration failed\n' >&2; status=1; fi
      if ! restore_unit_state peilv-dispatch.timer "$original_dispatch_timer_state"; then printf 'Dispatch timer state restoration failed\n' >&2; status=1; fi
    fi
    printf 'Deployment failed. Code rollback was attempted; database restoration was not performed.\n' >&2
  fi
  cleanup_temp_files
  exit "$status"
}
trap restore_on_failure EXIT

validate_unit_state peilv.service "$original_app_state"
validate_unit_state peilv-reconcile.timer "$original_reconcile_timer_state"
validate_unit_state peilv-dispatch.timer "$original_dispatch_timer_state"
[[ "$original_app_state" == "active" || "$original_app_state" == "inactive" ]] || { printf 'Application must be active or inactive before deployment\n' >&2; exit 1; }
[[ "$original_reconcile_timer_state" == "active" || "$original_reconcile_timer_state" == "inactive" ]] || { printf 'Reconcile timer must be active or inactive before deployment\n' >&2; exit 1; }
[[ "$original_dispatch_timer_state" == "active" || "$original_dispatch_timer_state" == "inactive" ]] || { printf 'Dispatch timer must be active or inactive before deployment\n' >&2; exit 1; }

[[ -f "$archive" && -f "$checksum" ]]
[[ ! -e "$backup" ]]
[[ -n "$old_release" && -d "$old_release" ]]
[[ "$(node --version)" =~ ^v22\. ]]
check_shared_env
verify_installed_curl_secret_helper
verify_installed_release_verifier
[[ -f "$candidate_stage_helper" && ! -L "$candidate_stage_helper" && "$(stat -c '%U:%G:%a:%h' "$candidate_stage_helper")" == root:root:755:1 ]]
# shellcheck source=/usr/local/libexec/peilv/candidate-stage.sh
source "$candidate_stage_helper"
source "$candidate_lifecycle_helper"
source "$deployment_budget_helper"
[[ "$CANDIDATE_STAGE_ROOT" == "$candidate_stage_root" ]]

checksum_line="$(sed -n '1p' "$checksum")"
checksum_sha="${checksum_line%% *}"
checksum_name="${checksum_line#"$checksum_sha"}"
checksum_name="${checksum_name# }"; checksum_name="${checksum_name# }"; checksum_name="${checksum_name#\*}"
[[ "$checksum_sha" == "$expected_sha" && "$checksum_name" == "peilv-$release_id.tar.gz" ]]
archive_kib=$(( ($(stat -c '%s' "$archive") + 1023) / 1024 ))
read -r expanded_kib expanded_inodes < <(deployment_archive_measure "$archive")
db_backup_kib="$(deployment_database_estimate_kib)"
deployment_budget_reset
deployment_budget_add "$private_archive" "$archive_kib" 1 private_archive
deployment_budget_add "$release_dir" "$expanded_kib" "$expanded_inodes" release_tree
deployment_budget_add "$candidate_stage" "$expanded_kib" "$expanded_inodes" candidate_tree
deployment_budget_add "$backup" "$db_backup_kib" 1 database_backup
deployment_budget_add "$systemd_backup_dir" "$DEPLOYMENT_SYSTEMD_KIB" 32 systemd_transaction
deployment_budget_check

install -d -o root -g root -m 0700 "$verified_incoming_dir"
[[ ! -L "$verified_incoming_dir" && "$(stat -c '%U:%G:%a' "$verified_incoming_dir")" == root:root:700 ]]
copied_sha="$(node "$private_copy_helper" "$archive" "$private_archive")"
[[ "$copied_sha" == "$expected_sha" ]]
register_temp_file "$private_archive"
[[ "$(stat -c '%U:%G:%a' "$private_archive")" == root:root:600 ]]

for mount in / /opt; do
  available_kb="$(df -Pk "$mount" | awk 'NR == 2 { print $4 }')"
  (( available_kb >= 2097152 ))
done
for container in local-data-postgres-1 local-data-postgrest-1 local-data-gateway-1; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == "true" ]]
done
[[ "$(readlink -f "$base/current")" == "$old_release" ]]
check_current_application 5000
verify_installed_app_unit_binding

install -d -o root -g root -m 0755 "$release_dir"
release_created=1
/usr/local/libexec/peilv/verify-release.sh --archive "$private_archive" "$expected_sha" "$release_dir" "peilv-$release_id.tar.gz" >/dev/null
chown -R root:root "$release_dir"
find "$release_dir" -type d -exec chmod 0555 {} +
find "$release_dir" -type f -exec chmod 0444 {} +
/usr/local/libexec/peilv/verify-release.sh --tree "$release_dir" --root-owned >/dev/null
if find "$release_dir" -type f -iname '.env*' -print -quit | grep -q .; then
  printf 'Release contains an environment file\n' >&2
  exit 1
fi

migration_plan="$(mktemp)"
register_temp_file "$migration_plan"
build_migration_plan() {
  RELEASE_MIGRATIONS="$release_dir/migrations" MIGRATION_PLAN="$migration_plan" node <<'NODE'
const crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const root=process.env.RELEASE_MIGRATIONS, manifest=JSON.parse(fs.readFileSync(path.join(root,"manifest.json"),"utf8"));
const fail=m=>{throw new Error(m)}, safeVersion=/^[0-9]{4}_[a-z0-9_]+$/, safeFile=/^[0-9]{4}_[a-z0-9_]+\.sql$/, sha=/^[0-9a-f]{64}$/;
if(manifest.schemaVersion!==1||!Array.isArray(manifest.migrations)||manifest.migrations.length===0)fail("Invalid migration manifest");
const actual=fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isFile()&&x.name.endsWith(".sql")).map(x=>x.name).sort();
const files=new Set(),versions=new Set(),rows=[];
const splitSqlList=value=>{const out=[];let token="",quoted=false;for(let i=0;i<value.length;i++){const c=value[i];if(c==="'"){token+=c;if(quoted&&value[i+1]==="'"){token+=value[++i];continue}quoted=!quoted;continue}if(c===","&&!quoted){out.push(token.trim());token=""}else token+=c}if(quoted)fail("Unterminated SQL string");out.push(token.trim());return out};
const readSqlParentheses=(text,start)=>{let depth=0,quoted=false,value="";for(let i=start;i<text.length;i++){const c=text[i];if(c==="'"){value+=c;if(quoted&&text[i+1]==="'"){value+=text[++i];continue}quoted=!quoted;continue}if(!quoted&&c==="("){depth++;if(depth===1)continue}if(!quoted&&c===")"){depth--;if(depth===0)return {value,end:i+1};if(depth<0)break}if(depth>0)value+=c}fail("Unterminated SQL parentheses")};
for(const m of manifest.migrations){
 if(!m||!safeFile.test(m.file)||!safeVersion.test(m.version)||!sha.test(m.sha256)||typeof m.codeRollbackSafe!=="boolean"||files.has(m.file)||versions.has(m.version))fail("Invalid, missing, or duplicate migration metadata");
 files.add(m.file);versions.add(m.version);const filePath=path.join(root,m.file);if(!fs.existsSync(filePath))fail(`Missing migration: ${m.file}`);
 const body=fs.readFileSync(filePath),actualSha=crypto.createHash("sha256").update(body).digest("hex");if(actualSha!==m.sha256)fail(`Migration SHA mismatch: ${m.file}`);
 const sqlText=body.toString("utf8"),writes=[];const re=/insert\s+into\s+(?:public\.)?schema_migrations\s*/gi;let match;
 while((match=re.exec(sqlText))){let cursor=match.index+match[0].length;if(sqlText[cursor]!=="(")fail(`Unparseable schema_migrations write: ${m.file}`);const columnGroup=readSqlParentheses(sqlText,cursor);cursor=columnGroup.end;const valuesKeyword=/^\s*values\s*/i.exec(sqlText.slice(cursor));if(!valuesKeyword)fail(`Unparseable schema_migrations write: ${m.file}`);cursor+=valuesKeyword[0].length;if(sqlText[cursor]!=="(")fail(`Unparseable schema_migrations write: ${m.file}`);const valueGroup=readSqlParentheses(sqlText,cursor);re.lastIndex=valueGroup.end;const columns=splitSqlList(columnGroup.value).map(x=>x.replace(/^["']|["']$/g,"").trim().toLowerCase()),values=splitSqlList(valueGroup.value),index=columns.indexOf("version");if(index<0||index>=values.length)fail(`Unparseable schema_migrations write: ${m.file}`);const literal=/^'((?:''|[^'])*)'$/.exec(values[index]);if(!literal)fail(`Non-literal schema_migrations version: ${m.file}`);writes.push(literal[1].replace(/''/g,"'"))}
 if(/insert\s+into\s+(?:public\.)?schema_migrations\b/i.test(sqlText)&&writes.length===0)fail(`Unparseable schema_migrations write: ${m.file}`);
 if(writes.some(version=>version!==m.version))fail(`SQL/manifest migration version mismatch: ${m.file}`);
 rows.push([m.file,m.version,m.sha256,m.codeRollbackSafe?"true":"false",writes.length?"self":"managed"].join("\t"));
}
const declared=[...files].sort();if(JSON.stringify(actual)!==JSON.stringify(declared))fail("Migration file set mismatch");
fs.writeFileSync(process.env.MIGRATION_PLAN,rows.join("\n")+"\n",{mode:0o600});
NODE
}
read_ledger_versions() {
  docker exec local-data-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select version from schema_migrations order by version"'
}
validate_ledger_against_plan() {
  local ledger_file declared_file
  ledger_file="$(mktemp)"; declared_file="$(mktemp)"; register_temp_file "$ledger_file"; register_temp_file "$declared_file"
  read_ledger_versions >"$ledger_file"
  awk -F '\t' '{print $2}' "$migration_plan" | sort -u >"$declared_file"
  sed -i 's/^0001_canonical_baseline$/0001_production_baseline/' "$ledger_file"
  [[ -z "$(sort "$ledger_file" | uniq -d)" ]] || { printf 'Migration ledger contains duplicate/alias-colliding versions\n' >&2; return 1; }
  comm -23 <(sort -u "$ledger_file") "$declared_file" | grep -q . && { printf 'Migration ledger contains versions unknown to verified manifest\n' >&2; return 1; }
  return 0
}
current_pending_plan() {
  local migration version migration_sha rollback_safe ledger_mode alias already_applied
  while IFS=$'\t' read -r migration version migration_sha rollback_safe ledger_mode; do
    aliases=("$version"); [[ "$migration" == "0001_production_baseline.sql" ]] && aliases+=("0001_canonical_baseline")
    already_applied=0
    for alias in "${aliases[@]}"; do
      if docker exec local-data-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select 1 from schema_migrations where version = '\''$1'\''"' sh "$alias" | grep -Fxq 1; then already_applied=1; break; fi
    done
    (( already_applied == 1 )) || printf '%s\t%s\t%s\n' "$migration" "$version" "$migration_sha"
  done <"$migration_plan"
}
build_migration_plan
validate_ledger_against_plan
verified_plan_sha="$(sha256sum "$migration_plan" | awk '{print $1}')"
pending_plan_before="$(current_pending_plan)"
mapfile -t migrations < <(awk -F '\t' '{print $1}' "$migration_plan")
pending_versions=()
pending_version_names=()
while IFS=$'\t' read -r migration version migration_sha rollback_safe ledger_mode; do
  aliases=("$version"); [[ "$migration" == "0001_production_baseline.sql" ]] && aliases+=("0001_canonical_baseline")
  already_applied=0
  for alias in "${aliases[@]}"; do
    if docker exec local-data-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select 1 from schema_migrations where version = '\''$1'\''"' sh "$alias" | grep -Fxq 1; then already_applied=1; break; fi
  done
  if (( already_applied == 0 )); then pending_versions+=("$migration"); pending_version_names+=("$version"); fi
done <"$migration_plan"

node --check "$release_dir/server.js"
candidate_openresty="$release_dir/infra/openresty/peilv-1panel-root.conf"
candidate_openresty_http="$release_dir/infra/openresty/peilv-1panel-http.conf"
[[ -f "$candidate_openresty" && -f "$candidate_openresty_http" ]]
public_host="$(read_env_value PEILV_PUBLIC_HOST)"
rendered_openresty="$(mktemp)"
register_temp_file "$rendered_openresty"
render_openresty_template "$candidate_openresty" "$rendered_openresty" "$public_host"
openresty_backup="$(mktemp)"
register_temp_file "$openresty_backup"
if [[ -f "$openresty_config" ]]; then cp -a "$openresty_config" "$openresty_backup"; else rm -f "$openresty_backup"; fi
openresty_http_backup="$(mktemp)"
register_temp_file "$openresty_http_backup"
if [[ -f "$openresty_http_config" ]]; then cp -a "$openresty_http_config" "$openresty_http_backup"; else rm -f "$openresty_http_backup"; fi

# Prove a disk-backed, hash-identical, read-only copy before any production write, backup, stop, or migration.
candidate_stage="$(candidate_prepare_stage "$release_dir" "$release_id" "$release_verifier")"
"$release_verifier" --tree "$candidate_stage" >/dev/null
candidate_started_at="$(date --iso-8601=seconds)"
candidate_start "$candidate_unit" "$release_id" "$candidate_stage" "$candidate_mount"
candidate_started=1
candidate_pin_netns "$candidate_unit" "$release_id" >/dev/null
candidate_wait_ready "$candidate_unit" "$release_id"
check_candidate_application 5001
if journalctl -u "$candidate_unit" --since "$candidate_started_at" --no-pager | grep -Eiq '(error|exception|fatal)'; then printf 'Candidate log contains an error\n' >&2; exit 1; fi
stop_candidate
build_migration_plan
[[ "$(sha256sum "$migration_plan" | awk '{print $1}')" == "$verified_plan_sha" ]] || { printf 'Verified migration plan changed after candidate validation\n' >&2; exit 1; }
validate_ledger_against_plan
[[ "$(current_pending_plan)" == "$pending_plan_before" ]] || { printf 'Pending migration file/version/SHA set changed after candidate validation\n' >&2; exit 1; }

# Classify rollback safety only after candidate success, before production is touched.
if ((${#pending_versions[@]})); then
  set +e
  PENDING="$(printf '%s\n' "${pending_versions[@]}")" MANIFEST="$release_dir/migrations/manifest.json" node <<'NODE'
const fs=require("node:fs");const pending=new Set((process.env.PENDING||"").split("\n").filter(Boolean));const manifest=JSON.parse(fs.readFileSync(process.env.MANIFEST,"utf8"));
if(manifest.migrations.some(x=>pending.has(x.file)&&x.codeRollbackSafe===false))process.exit(42);
NODE
  status=$?
  set -e
  [[ "$status" == 0 ]] || { [[ "$status" == 42 ]] && incompatible_migration_pending=1 || exit "$status"; }
fi
[[ ! -e /var/lib/peilv/deploy-transaction.json ]] || { printf 'Unfinished deployment transaction requires recovery before a new deployment\n' >&2; exit 1; }
if (( incompatible_migration_pending == 1 )) && [[ "$maintenance_confirmation" != --maintenance-window-confirmed ]]; then
  printf 'Pending migration is not code-rollback-safe; explicit maintenance window confirmation is required\n' >&2
  exit 1
fi

[[ "$(readlink -f "$base/current")" == "$old_release" ]]
/usr/local/libexec/peilv/verify-release.sh --tree "$release_dir" --root-owned >/dev/null
[[ ! -e "$backup" ]]
for container in local-data-postgres-1 local-data-postgrest-1 local-data-gateway-1; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == "true" ]]
done
check_current_application 5000
check_preupgrade_https_edge

write_transaction_state maintenance_entering
transaction_started=1
systemctl stop peilv-dispatch.timer peilv-reconcile.timer
timers_stopped=1
systemctl reset-failed peilv-dispatch.service peilv-reconcile.service
wait_for_inactive peilv-dispatch.service
wait_for_inactive peilv-reconcile.service

systemctl stop peilv.service
app_stopped=1

install -d -o root -g peilv -m 0750 "$base/backups"
backup_partial="$backup.partial"
[[ ! -e "$backup_partial" && ! -L "$backup_partial" ]]
register_temp_file "$backup_partial"
docker exec local-data-postgres-1 sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_partial"
chmod 0640 "$backup_partial"
test -s "$backup_partial"
docker exec -i local-data-postgres-1 pg_restore -l < "$backup_partial" >/dev/null
sync -f "$backup_partial"
mv -T "$backup_partial" "$backup"
sync -d "$base/backups"
backup_sha="$(sha256sum "$backup" | awk '{print $1}')"
write_transaction_state backup_complete

applied=()
build_migration_plan
[[ "$(sha256sum "$migration_plan" | awk '{print $1}')" == "$verified_plan_sha" ]] || { printf 'Verified migration plan changed before migration execution\n' >&2; exit 1; }
validate_ledger_against_plan
[[ "$(current_pending_plan)" == "$pending_plan_before" ]] || { printf 'Pending migration file/version/SHA set changed before migration execution\n' >&2; exit 1; }
migration_started=1
(( incompatible_migration_pending == 1 )) && incompatible_migration_started=1
write_transaction_state migration_running
while IFS=$'\t' read -r migration _; do applied+=("$migration"); done < <(current_pending_plan)
/usr/bin/node "$release_dir/scripts/run-migrations.mjs" "$release_dir/migrations" "$migration_plan"
build_migration_plan
validate_ledger_against_plan
remaining_pending=()
while IFS=$'\t' read -r migration version migration_sha rollback_safe ledger_mode; do
  aliases=("$version"); [[ "$migration" == "0001_production_baseline.sql" ]] && aliases+=("0001_canonical_baseline")
  found=0; for alias in "${aliases[@]}"; do docker exec local-data-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select 1 from schema_migrations where version = '\''$1'\''"' sh "$alias" | grep -Fxq 1 && { found=1; break; }; done
  (( found == 1 )) || remaining_pending+=("$migration")
done <"$migration_plan"
(( ${#remaining_pending[@]} == 0 )) || { printf 'Migration pending set changed or remains incomplete after execution\n' >&2; exit 1; }
migration_completed=1
write_transaction_state migration_complete

docker logs --since 5m local-data-postgrest-1 2>&1 | grep -Eiq '(panic|fatal)' && {
  printf 'PostgREST reported a fatal migration error\n' >&2
  exit 1
}

# Candidate code is now proven without credentials. Only now may proxy/helper enter the trusted host transaction.
install -D -o root -g root -m 0644 "$rendered_openresty" "$openresty_config"
install -D -o root -g root -m 0644 "$candidate_openresty_http" "$openresty_http_config"
openresty_changed=1
write_transaction_state proxy_replacing
"$openresty_control" reload
[[ "$(sha256sum "$openresty_config" | awk '{print $1}')" == "$(sha256sum "$rendered_openresty" | awk '{print $1}')" ]]
[[ "$(sha256sum "$openresty_http_config" | awk '{print $1}')" == "$(sha256sum "$candidate_openresty_http" | awk '{print $1}')" ]]
stage_release_systemd_units "$release_dir"
systemd_units_transaction_started=1
commit_staged_systemd_units

ln -s "$release_dir" "$base/current.next"
write_transaction_state symlink_switching
mv -Tf "$base/current.next" "$base/current"
switched=1
release_activated=1
systemctl start peilv.service
for _ in {1..30}; do
  curl -fsS http://127.0.0.1:5000/ >/dev/null 2>&1 && break
  systemctl is-failed --quiet peilv.service && break
  sleep 1
done

[[ "$(readlink -f "$base/current")" == "$release_dir" ]]
[[ "$(systemctl is-active peilv.service)" == "active" ]]
ss -lntH 'sport = :5000' | awk 'NF && $4 !~ /^(127\.0\.0\.1|\[::1\]):5000$/ { exit 1 } END { if (NR == 0) exit 1 }'
check_formal_application 5000
check_secure_cookie_probe

systemctl start peilv-reconcile.service
[[ "$(systemctl show peilv-reconcile.service -p Result --value)" == "success" ]]
systemctl start peilv-reconcile.timer
systemctl start peilv-dispatch.service
[[ "$(systemctl show peilv-dispatch.service -p Result --value)" == "success" ]]
systemctl start peilv-dispatch.timer

[[ "$(systemctl is-active peilv-reconcile.timer)" == "active" ]]
[[ "$(systemctl is-active peilv-dispatch.timer)" == "active" ]]
LEDGER_PATH="$base/deployment-ledger.json" RELEASE_ID="$release_id" PREVIOUS_RELEASE="$old_release_id" REQUEST_ID="$request_id" node <<'NODE'
const fs = require("node:fs");
const path = process.env.LEDGER_PATH;
let ledger = { schemaVersion: 1, events: [] };
try { ledger = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.events)) throw new Error("Invalid deployment ledger");
ledger.events.push({ kind: "deploy", releaseId: process.env.RELEASE_ID, previousReleaseId: process.env.PREVIOUS_RELEASE, requestId: process.env.REQUEST_ID, completedAt: new Date().toISOString() });
ledger.events = ledger.events.slice(-100);
const temporary = `${path}.next`;
fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o640 });
fs.renameSync(temporary, path);
NODE
completed=1
rm -f "$transaction_state"
node -e 'const fs=require("node:fs");const fd=fs.openSync("/var/lib/peilv","r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}'
[[ -z "$openresty_backup" ]] || rm -f "$openresty_backup"
rm -f "$rendered_openresty"

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
