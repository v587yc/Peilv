#!/usr/bin/env bash
set -Eeuo pipefail

usage='Usage: production-preflight.sh <release-id> <commit-sha> <source-run-id> <source-run-attempt> <source-artifact-id> <archive-sha256> <request-id> <migration-csv> <uploaded-archive-path> [--approved-current-unit-hotfix-transition]'
release_id="${1:?$usage}"
commit_sha="${2:?$usage}"
source_run_id="${3:?$usage}"
source_run_attempt="${4:?$usage}"
source_artifact_id="${5:?$usage}"
archive_sha="${6:?$usage}"
request_id="${7:?$usage}"
migration_csv="${8:-}"
uploaded_archive="${9:?$usage}"
transition_confirmation="${10:-}"
[[ -z "$transition_confirmation" || "$transition_confirmation" == --approved-current-unit-hotfix-transition ]] || { printf 'Unknown preflight option: %s\n' "$transition_confirmation" >&2; exit 1; }

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
archive="$base/incoming/peilv-$release_id.tar.gz"
verified_incoming_dir=/var/lib/peilv/incoming-verified
private_archive="$verified_incoming_dir/preflight-$request_id.tar.gz"
verified_tree="$verified_incoming_dir/preflight-$request_id.tree"
blockers=()
checks=()
pending=()
unknown=()
declared_versions=()
transition_approved=0
curl_secret_helper=/usr/local/libexec/peilv/curl-secret.sh
trusted_helper_sha_file=/etc/peilv/trusted-curl-secret.sha256
release_verifier=/usr/local/libexec/peilv/verify-release.sh
private_copy_helper=/usr/local/libexec/peilv/private-copy.mjs
trusted_verifier_sha_file=/etc/peilv/trusted-release-verifier.sha256
trusted_verifier_helper=/usr/local/libexec/peilv/trusted-release-verifier.sh
candidate_stage_helper=/usr/local/libexec/peilv/candidate-stage.sh
deployment_budget_helper=/usr/local/libexec/peilv/deployment-budget.sh
openresty_control=/usr/local/libexec/peilv/openresty-control
openresty_http_config=/opt/1panel/www/conf.d/peilv-http.conf
openresty_root_config=/opt/1panel/www/sites/pb.aixid.cc/proxy/root.conf
candidate_stage_root=/var/lib/peilv/candidate-stage
internal_secret_file="$base/shared/credentials/internal-api-secret"
temp_files=()
register_temp_file() { temp_files+=("$1"); }
cleanup_temp_files() { local path; for path in "${temp_files[@]:-}"; do [[ -z "$path" ]] && continue; if [[ -d "$path" && ! -L "$path" ]]; then rm -rf --one-file-system -- "$path"; else rm -f -- "$path"; fi; done; }
trap cleanup_temp_files EXIT
trap 'cleanup_temp_files; exit 129' HUP
trap 'cleanup_temp_files; exit 130' INT
trap 'cleanup_temp_files; exit 143' TERM

verify_installed_release_verifier() {
  [[ -f "$trusted_verifier_helper" && ! -L "$trusted_verifier_helper" && "$(stat -c '%U:%G:%a:%h' "$trusted_verifier_helper")" == root:root:755:1 ]] || return 1
  "$trusted_verifier_helper" "$trusted_verifier_sha_file" /usr/local/libexec/peilv
}
measured_archive_sha=""
if [[ "$uploaded_archive" != "/tmp/peilv-preflight-$request_id.tar.gz" || ! -f "$uploaded_archive" || -L "$uploaded_archive" ]]; then
  printf 'Preflight archive path is invalid\n' >&2
  exit 1
fi
verify_installed_release_verifier || { printf 'Trusted host release verifier is not correctly installed\n' >&2; exit 1; }
[[ -f "$candidate_stage_helper" && ! -L "$candidate_stage_helper" && "$(stat -c '%U:%G:%a:%h' "$candidate_stage_helper")" == root:root:755:1 ]] || { printf 'Trusted candidate staging helper is not correctly installed\n' >&2; exit 1; }
# shellcheck source=/usr/local/libexec/peilv/candidate-stage.sh
source "$candidate_stage_helper"
source "$deployment_budget_helper"
[[ "$CANDIDATE_STAGE_ROOT" == "$candidate_stage_root" ]] || { printf 'Candidate staging root is not fixed\n' >&2; exit 1; }

exec 9>/run/lock/peilv-deploy.lock
if ! flock -n 9; then printf 'Another server-side deployment or preflight is running\n' >&2; exit 1; fi
archive_kib=$(( ($(stat -c '%s' "$uploaded_archive") + 1023) / 1024 ))
read -r expanded_kib expanded_inodes < <(deployment_archive_measure "$uploaded_archive")
db_backup_kib="$(deployment_database_estimate_kib)"
deployment_budget_reset
deployment_budget_add "$private_archive" "$archive_kib" 1 private_archive
deployment_budget_add "$verified_tree" "$expanded_kib" "$expanded_inodes" verified_tree
deployment_budget_add "$target_release" "$expanded_kib" "$expanded_inodes" release_tree
deployment_budget_add "$candidate_stage_root/$release_id" "$expanded_kib" "$expanded_inodes" candidate_tree
deployment_budget_add "$backup_path" "$db_backup_kib" 1 database_backup
deployment_budget_add "/var/lib/peilv/systemd-transactions/$release_id" "$DEPLOYMENT_SYSTEMD_KIB" 32 systemd_transaction
deployment_budget_check
peak_storage_budget_ok=1

register_temp_file "$private_archive"
register_temp_file "$verified_tree"
install -d -o root -g root -m 0700 "$verified_incoming_dir"
[[ ! -L "$verified_incoming_dir" && "$(stat -c '%U:%G:%a' "$verified_incoming_dir")" == root:root:700 ]]
measured_archive_sha="$(node "$private_copy_helper" "$uploaded_archive" "$private_archive")"
install -d -o root -g root -m 0700 "$verified_tree"
if [[ "$measured_archive_sha" != "$archive_sha" ]]; then printf 'Measured preflight archive SHA does not match candidate\n' >&2; exit 1; fi
/usr/local/libexec/peilv/verify-release.sh --archive "$private_archive" "$measured_archive_sha" "$verified_tree" "peilv-$release_id.tar.gz" >/dev/null
/usr/local/libexec/peilv/verify-release.sh --tree "$verified_tree" >/dev/null
verified_migration_csv="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.migrations.map(x=>`${x.file}=${x.version}`).join(","))' "$verified_tree/migrations/manifest.json")"
if [[ "$migration_csv" != "$verified_migration_csv" ]]; then printf 'Migration list does not match the verified release manifest\n' >&2; exit 1; fi
verify_installed_curl_secret_helper() {
  local expected
  [[ -f "$curl_secret_helper" && ! -L "$curl_secret_helper" && "$(stat -c '%U:%G:%a' "$curl_secret_helper")" == root:root:755 ]] || return 1
  [[ -f "$trusted_helper_sha_file" && ! -L "$trusted_helper_sha_file" && "$(stat -c '%U:%G:%a' "$trusted_helper_sha_file")" == root:root:644 ]] || return 1
  expected="$(awk 'NR==1{print $1}' "$trusted_helper_sha_file")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$(sha256sum "$curl_secret_helper" | awk '{print $1}')" == "$expected" ]]
}
read_env_value() {
  local key="$1" file="$base/shared/app.env" line
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
  line="${line#*=}"; line="${line%$'\r'}"
  if [[ "$line" == \"*\" && "$line" == *\" ]]; then line="${line:1:${#line}-2}"; elif [[ "$line" == \'*\' && "$line" == *\' ]]; then line="${line:1:${#line}-2}"; fi
  printf '%s' "$line"
}

check_passed() { checks+=("$1=passed"); }
check_blocked() { checks+=("$1=blocked"); blockers+=("$2"); }

verify_app_unit_contract() {
  local unit="$1" key expected
  [[ -f "$unit" && ! -L "$unit" ]] || return 1
  for expected in 'HOSTNAME=127.0.0.1' 'PORT=5000' 'DEPLOY_RUN_PORT=5000'; do
    key="${expected%%=*}"
    [[ "$(grep -Ec "^Environment=${key}=" "$unit")" == 1 ]] && grep -Fxq "Environment=$expected" "$unit" || return 1
  done
  ! grep -Eq 'Environment=(HOSTNAME=0\.0\.0\.0|PORT=3000|DEPLOY_RUN_PORT=3000)$' "$unit" &&
    grep -Fxq 'ExecStart=/usr/bin/node /opt/peilv/current/server.js' "$unit"
}

approve_current_unit_hotfix_transition() {
  local current_id="$1" current_unit="$2" installed_unit="$3" candidate_unit="$4" pending_count="$5" unknown_count="$6" latest_version="$7" listeners="$8"
  [[ "$transition_confirmation" == --approved-current-unit-hotfix-transition ]] || return 1
  [[ "$current_id" == r20260716074436-a1-a8f074c3680f ]] || return 1
  verify_app_unit_contract "$candidate_unit" && verify_app_unit_contract "$installed_unit" || return 1
  [[ -f "$current_unit" && ! -L "$current_unit" ]] || return 1
  for key in HOSTNAME PORT DEPLOY_RUN_PORT; do [[ "$(grep -Ec "^Environment=${key}=" "$current_unit")" == 0 ]] || return 1; done
  grep -Fxq 'ExecStart=/usr/bin/node /opt/peilv/current/server.js' "$current_unit" || return 1
  CURRENT_UNIT="$current_unit" INSTALLED_UNIT="$installed_unit" node <<'NODE' || return 1
const fs = require("node:fs");
const approved = new Set(["Environment=HOSTNAME=127.0.0.1", "Environment=PORT=5000", "Environment=DEPLOY_RUN_PORT=5000"]);
const current = fs.readFileSync(process.env.CURRENT_UNIT, "utf8").split("\n");
const installed = fs.readFileSync(process.env.INSTALLED_UNIT, "utf8").split("\n");
const found = installed.filter(line => approved.has(line));
if (found.length !== 3 || new Set(found).size !== 3) process.exit(1);
if (installed.filter(line => !approved.has(line)).join("\n") !== current.join("\n")) process.exit(1);
NODE
  [[ "$pending_count" == 0 && "$unknown_count" == 0 && "$latest_version" == 0014_admin_login_uniform_reservations ]] || return 1
  [[ -n "$listeners" ]] && awk '$4 !~ /^(127\.0\.0\.1|\[::1\]):5000$/ { exit 1 }' <<<"$listeners"
}

if (( peak_storage_budget_ok == 1 )); then check_passed peak_storage_budget; else check_blocked peak_storage_budget "Aggregated filesystem block/inode/quota budget is insufficient"; fi

if [[ -z "$current_release_path" || ! -d "$current_release_path" ]]; then
  check_blocked current_release "Current release is invalid"
else
  check_passed current_release
fi
candidate_app_unit="$verified_tree/infra/systemd/peilv.service"
current_app_unit="$current_release_path/infra/systemd/peilv.service"
installed_app_unit=/etc/systemd/system/peilv.service
if verify_app_unit_contract "$candidate_app_unit"; then
  check_passed candidate_app_unit_contract
else
  check_blocked candidate_app_unit_contract "Candidate application systemd listener contract is missing or invalid"
fi
if [[ -e "$target_release" || -e "$backup_path" ]]; then
  check_blocked target_paths "Target release or backup already exists"
else
  check_passed target_paths
fi

for unit in peilv.service peilv-dispatch.timer peilv-reconcile.timer; do
  if [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" != "active" ]]; then
    check_blocked "unit:$unit" "Required unit is not active: $unit"
  else
    check_passed "unit:$unit"
  fi
done
for unit in peilv-dispatch.service peilv-reconcile.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    check_passed "unit:$unit"
  else
    check_blocked "unit:$unit" "Required oneshot unit is not installed: $unit"
  fi
done
systemd_version="$(systemctl --version | awk 'NR==1 {print $2}')"
if [[ "$systemd_version" =~ ^[0-9]+$ ]] && (( systemd_version >= 247 )); then
  check_passed systemd_credentials_version
else
  check_blocked systemd_credentials_version "systemd 247 or newer is required for LoadCredential"
fi
for unit in peilv.service peilv-reconcile.service peilv-dispatch.service; do
  unit_contract="$(cat "$verified_tree/infra/systemd/$unit" 2>/dev/null || true)"
  if grep -Fq 'LoadCredential=internal-api-secret:/opt/peilv/shared/credentials/internal-api-secret' <<<"$unit_contract" &&
     grep -Fq 'Environment=NODE_ENV=production' <<<"$unit_contract" &&
     grep -Fq 'NoNewPrivileges=true' <<<"$unit_contract" && grep -Fq 'ProtectProc=invisible' <<<"$unit_contract" &&
     grep -Fq 'ProcSubset=pid' <<<"$unit_contract" && grep -Fq 'PrivateDevices=true' <<<"$unit_contract" &&
     grep -Fq 'ProtectKernelTunables=true' <<<"$unit_contract" && grep -Fq 'ProtectKernelModules=true' <<<"$unit_contract" &&
     grep -Fq 'ProtectControlGroups=true' <<<"$unit_contract" && grep -Fq 'RestrictSUIDSGID=true' <<<"$unit_contract" &&
     grep -Fq 'LockPersonality=true' <<<"$unit_contract"; then
    check_passed "credential_unit:$unit"
  else
    check_blocked "credential_unit:$unit" "Systemd credential/process-hardening contract is missing: $unit"
  fi
done
for account in peilv-app peilv-reconcile peilv-dispatch peilv-probe; do
  if getent passwd "$account" >/dev/null && id -nG "$account" | tr ' ' '\n' | grep -Fxq peilv; then
    check_passed "service_account:$account"
  else
    check_blocked "service_account:$account" "Dedicated service account must exist and belong to the read-only peilv code group: $account"
  fi
done
if getent passwd peilv-candidate >/dev/null && [[ "$(id -gn peilv-candidate)" == peilv-candidate ]] && [[ "$(id -nG peilv-candidate)" == peilv-candidate ]]; then
  check_passed service_account:peilv-candidate
else
  check_blocked service_account:peilv-candidate "Candidate must use an isolated uid/gid and must not belong to the peilv group"
fi

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

listeners_5000="$(ss -lntH 'sport = :5000' 2>/dev/null || true)"
if [[ -n "$listeners_5000" ]] && awk '$4 !~ /^(127\.0\.0\.1|\[::1\]):5000$/ { exit 1 }' <<<"$listeners_5000"; then
  check_passed production_port
else
  check_blocked production_port "Production port 5000 must listen only on loopback"
fi

validate_openresty_candidate() {
  local candidate="$1"
  grep -Eq 'limit_req_zone[[:space:]]+\$peilv_admin_auth_strict_key[[:space:]]+zone=peilv_admin_auth_strict_rate:' "$candidate" &&
  grep -Eq 'limit_conn_zone[[:space:]]+\$peilv_admin_auth_strict_key[[:space:]]+zone=peilv_admin_auth_strict_conn:' "$candidate" &&
  grep -Eq 'limit_req_zone[[:space:]]+\$peilv_admin_auth_probe_key[[:space:]]+zone=peilv_admin_auth_probe_rate:' "$candidate" &&
  grep -Eq 'limit_conn_zone[[:space:]]+\$peilv_admin_auth_probe_key[[:space:]]+zone=peilv_admin_auth_probe_conn:' "$candidate" &&
  grep -Eq '\^\(POST\|DELETE\):/api/auth/session\$[[:space:]]+\$binary_remote_addr;' "$candidate" &&
  grep -Eq '\^POST:/api/auth/bootstrap\$[[:space:]]+\$binary_remote_addr;' "$candidate" &&
  grep -Eq '\^\(GET\|HEAD\):/api/auth/session\$[[:space:]]+\$binary_remote_addr;' "$candidate" &&
  grep -Eq 'if[[:space:]]+\(\$peilv_session_method_allowed[[:space:]]+=[[:space:]]+0\)[[:space:]]+\{[[:space:]]+return[[:space:]]+405;' "$candidate" &&
  grep -Eq 'if[[:space:]]+\(\$peilv_bootstrap_method_allowed[[:space:]]+=[[:space:]]+0\)[[:space:]]+\{[[:space:]]+return[[:space:]]+405;' "$candidate" &&
  grep -Eq 'client_max_body_size[[:space:]]+16k;' "$candidate" &&
  grep -Eq 'client_body_timeout[[:space:]]+5s;' "$candidate" &&
  grep -Eq 'limit_req[[:space:]]+zone=peilv_admin_auth_strict_rate[[:space:]]+burst=3[[:space:]]+nodelay;' "$candidate" &&
  grep -Eq 'limit_conn[[:space:]]+peilv_admin_auth_strict_conn[[:space:]]+2;' "$candidate" &&
  grep -Eq 'limit_req[[:space:]]+zone=peilv_admin_auth_probe_rate[[:space:]]+burst=30[[:space:]]+nodelay;' "$candidate" &&
  grep -Eq 'limit_conn[[:space:]]+peilv_admin_auth_probe_conn[[:space:]]+10;' "$candidate" &&
  grep -Eq 'proxy_connect_timeout[[:space:]]+3s;' "$candidate" &&
  grep -Eq 'proxy_read_timeout[[:space:]]+30s;' "$candidate" &&
  grep -Eq 'proxy_pass[[:space:]]+http://127\.0\.0\.1:5000;' "$candidate" &&
  grep -Eq 'proxy_set_header[[:space:]]+X-Forwarded-For[[:space:]]+\$remote_addr;' "$candidate" &&
  grep -Eq 'listen[[:space:]]+80;' "$candidate" && grep -Eq 'server_name[[:space:]]+[A-Za-z0-9.-]+;' "$candidate" && grep -Eq 'return[[:space:]]+301[[:space:]]+https://[A-Za-z0-9.-]+\$request_uri;' "$candidate" &&
  grep -Eq 'listen[[:space:]]+443[[:space:]]+ssl;' "$candidate" &&
  grep -Eq 'ssl_certificate[[:space:]]+/etc/peilv/tls/fullchain\.pem;' "$candidate" &&
  grep -Eq 'ssl_certificate_key[[:space:]]+/etc/peilv/tls/privkey\.pem;' "$candidate" &&
  grep -Eq 'Strict-Transport-Security.*max-age=31536000' "$candidate" &&
  grep -Eq 'proxy_set_header[[:space:]]+Forwarded[[:space:]]+"for=\$remote_addr;proto=https";' "$candidate" &&
  grep -Eq 'proxy_set_header[[:space:]]+X-Forwarded-Proto[[:space:]]+https;' "$candidate" &&
  ! grep -q '\$proxy_add_x_forwarded_for' "$candidate" && ! grep -q '\$host' "$candidate"
}

candidate_proxy="$(mktemp)"
register_temp_file "$candidate_proxy"
candidate_wrapper="$(mktemp)"
register_temp_file "$candidate_wrapper"
public_host=""
if [[ -f "$base/shared/app.env" ]]; then public_host="$(read_env_value PEILV_PUBLIC_HOST)"; fi
render_openresty_template() {
  local template="$1" output="$2" host="$3"
  [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] && [[ "$host" != *..* ]] &&
  grep -q '__PEILV_PUBLIC_HOST__' "$template" && ! grep -q '\$host' "$template" &&
  sed "s/__PEILV_PUBLIC_HOST__/$host/g" "$template" >"$output" && ! grep -q '__PEILV_PUBLIC_HOST__' "$output"
}
candidate_template="$(mktemp)"
register_temp_file "$candidate_template"
if [[ -f "$verified_tree/infra/openresty/peilv.conf" ]] && cp "$verified_tree/infra/openresty/peilv.conf" "$candidate_template" &&
   render_openresty_template "$candidate_template" "$candidate_proxy" "$public_host" &&
   validate_openresty_candidate "$candidate_proxy" && "$openresty_control" test; then
  check_passed admin_edge_configuration
else
  check_blocked admin_edge_configuration "Candidate OpenResty configuration is missing or unsafe"
fi
if verify_installed_curl_secret_helper; then
  check_passed active_curl_secret_helper
else
  check_blocked active_curl_secret_helper "Installed curl secret helper does not match the root-owned trusted hash"
fi
active_units_ok=1
for unit in peilv.service peilv-reconcile.service peilv-reconcile.timer peilv-dispatch.service peilv-dispatch.timer; do
  [[ -f "/etc/systemd/system/$unit" && ! -L "/etc/systemd/system/$unit" && "$(stat -c '%U:%G:%h' "/etc/systemd/system/$unit" 2>/dev/null || true)" == root:root:1 ]] || active_units_ok=0
done

if candidate_assert_stage_root && candidate_check_capacity "$verified_tree" >/dev/null; then
  check_passed candidate_staging
else
  check_blocked candidate_staging "Candidate staging must be root:root 0700, disk-backed, non-symlink, and have release size plus safety margin available"
fi
if (( active_units_ok == 1 )); then check_passed active_systemd_unit_hashes; else check_blocked active_systemd_unit_hashes "Installed systemd units are not root-owned regular single-link files"; fi
if [[ -f "$openresty_root_config" && ! -L "$openresty_root_config" && "$(stat -c '%U:%G:%h' "$openresty_root_config")" == root:root:1 ]] &&
   [[ ! -e "$openresty_http_config" || ( -f "$openresty_http_config" && ! -L "$openresty_http_config" && "$(stat -c '%U:%G:%h' "$openresty_http_config")" == root:root:1 ) ]] &&
   [[ "$(sha256sum "$openresty_root_config" | awk '{print $1}')" =~ ^[0-9a-f]{64}$ ]] && "$openresty_control" test; then
  check_passed active_openresty_hash
else
  check_blocked active_openresty_hash "Active OpenResty configuration does not match the current release"
fi

for certificate in /opt/1panel/www/sites/pb.aixid.cc/ssl/fullchain.pem /opt/1panel/www/sites/pb.aixid.cc/ssl/privkey.pem; do
  if [[ -f "$certificate" && -r "$certificate" ]]; then check_passed "tls:$certificate"; else check_blocked "tls:$certificate" "TLS certificate material is missing: $certificate"; fi
done
certificate=/opt/1panel/www/sites/pb.aixid.cc/ssl/fullchain.pem
private_key=/opt/1panel/www/sites/pb.aixid.cc/ssl/privkey.pem
private_mode="$(stat -c '%a' "$private_key" 2>/dev/null || printf 777)"
if [[ "$private_mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$private_mode & 0137) == 0 )); then check_passed tls_private_key_mode; else check_blocked tls_private_key_mode "TLS private key mode must not be wider than 0640"; fi
if openssl x509 -checkend 604800 -noout -in "$certificate" >/dev/null 2>&1; then check_passed tls_expiry; else check_blocked tls_expiry "TLS certificate expires within 7 days or is invalid"; fi
cert_pub="$(openssl x509 -in "$certificate" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
key_pub="$(openssl pkey -in "$private_key" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')"
if [[ -n "$cert_pub" && "$cert_pub" == "$key_pub" ]]; then check_passed tls_key_match; else check_blocked tls_key_match "TLS certificate and private key do not match"; fi
if openssl x509 -help 2>&1 | grep -q -- '-checkhost'; then
  hostname_valid=0
  openssl x509 -checkhost "$public_host" -noout -in "$certificate" >/dev/null 2>&1 && hostname_valid=1
else
  hostname_valid=0
  openssl verify -verify_hostname "$public_host" -CAfile "$certificate" "$certificate" >/dev/null 2>&1 && hostname_valid=1
fi
if (( hostname_valid == 1 )); then check_passed tls_hostname; else check_blocked tls_hostname "TLS certificate SAN does not cover PEILV_PUBLIC_HOST"; fi

for container in local-data-postgres-1 local-data-postgrest-1 local-data-gateway-1; do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]]; then
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
latest_applied_version="$(printf '%s\n' "${applied_versions[@]}" | sort | awk 'NF{value=$0} END{print value}')"
if verify_app_unit_contract "$current_app_unit" && verify_app_unit_contract "$installed_app_unit" && cmp -s "$installed_app_unit" "$current_app_unit"; then
  check_passed active_app_unit_release_binding
elif approve_current_unit_hotfix_transition "$current_release" "$current_app_unit" "$installed_app_unit" "$candidate_app_unit" "${#pending[@]}" "${#unknown[@]}" "$latest_applied_version" "$listeners_5000"; then
  transition_approved=1
  check_passed active_app_unit_release_binding
  check_passed approved_current_unit_hotfix_transition
else
  check_blocked active_app_unit_release_binding "Installed application systemd unit is missing, invalid, or drifted from the current release"
fi

if [[ -f "$base/shared/app.env" ]]; then
  env_owner="$(stat -c '%U' "$base/shared/app.env")"
  env_mode="$(stat -c '%a' "$base/shared/app.env")"
  if [[ "$env_owner" == root ]] && (( (8#$env_mode & 022) == 0 )); then
    check_passed shared_environment
  else
    check_blocked shared_environment "Shared environment file ownership or mode is unsafe"
  fi
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(INTERNAL_API_SECRET|INTERNAL_API_SECRET_FILE|CREDENTIALS_DIRECTORY|NODE_OPTIONS|NODE_PATH|LD_PRELOAD)=' "$base/shared/app.env"; then
    check_blocked internal_secret_environment "Secret and runtime preload injection keys must be removed from app.env"
  else
    check_passed internal_secret_environment
  fi
  secret_owner="$(stat -c '%U' "$internal_secret_file" 2>/dev/null || true)"
  secret_mode="$(stat -c '%a' "$internal_secret_file" 2>/dev/null || true)"
  secret_parent_safe=1
  current_parent="$(dirname "$internal_secret_file")"
  while [[ "$current_parent" != / ]]; do
    [[ ! -L "$current_parent" ]] || secret_parent_safe=0
    parent_mode="$(stat -c '%a' "$current_parent" 2>/dev/null || printf 777)"
    (( (8#$parent_mode & 022) == 0 )) || secret_parent_safe=0
    current_parent="$(dirname "$current_parent")"
  done
  secret_value="$(cat "$internal_secret_file" 2>/dev/null; printf _ )"; secret_value="${secret_value%_}"
  [[ "$secret_value" == *$'\n' ]] && secret_value="${secret_value%$'\n'}"
  if [[ -f "$internal_secret_file" && ! -L "$internal_secret_file" && "$secret_owner" == root && "$secret_mode" == 600 && "$secret_parent_safe" == 1 ]] &&
     [[ "${#secret_value}" -ge 32 && "${#secret_value}" -le 128 && "$secret_value" =~ ^[A-Za-z0-9_-]+$ ]] &&
     [[ "$(stat -c '%h' "$internal_secret_file")" == 1 && "$(wc -c <"$internal_secret_file")" -le 129 ]]; then
    check_passed internal_secret_credential
  else
    check_blocked internal_secret_credential "Internal API credential must be a root-owned non-symlink 0600 file"
  fi

  admin_table="$(docker exec local-data-postgres-1 sh -lc \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select coalesce(to_regclass('\''public.admin_users'\'')::text,'\'''\'');"' 2>/dev/null || true)"
  if [[ -z "$admin_table" ]]; then
    admin_count=0
  else
    admin_count="$(docker exec local-data-postgres-1 sh -lc \
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select count(*) from admin_users;"' 2>/dev/null || true)"
  fi
  admin_rate_secret="$(read_env_value ADMIN_LOGIN_RATE_LIMIT_SECRET)"
  if (( ${#admin_rate_secret} >= 32 )); then
    check_passed admin_security_environment
  else
    check_blocked admin_security_environment "ADMIN_LOGIN_RATE_LIMIT_SECRET must contain at least 32 characters"
  fi
  [[ "$public_host" =~ ^[A-Za-z0-9.-]+$ ]] && check_passed public_https_host || check_blocked public_https_host "PEILV_PUBLIC_HOST is missing or invalid"
  admin_trust_proxy="$(read_env_value ADMIN_TRUST_PROXY)"
  if [[ "$admin_trust_proxy" == "true" ]]; then
    check_passed admin_proxy_boundary
  else
    check_blocked admin_proxy_boundary "Controlled OpenResty deployment requires ADMIN_TRUST_PROXY=true"
  fi
  if [[ "$admin_count" =~ ^[1-9][0-9]*$ ]]; then
    admin_bootstrap_token="$(read_env_value ADMIN_BOOTSTRAP_TOKEN)"
    if [[ -z "$admin_bootstrap_token" ]]; then
      check_passed admin_bootstrap_cleanup
    else
      check_blocked admin_bootstrap_cleanup "ADMIN_BOOTSTRAP_TOKEN must be removed after initialization"
    fi
  elif [[ "$admin_count" == 0 ]] && [[ -n "$(read_env_value ADMIN_BOOTSTRAP_TOKEN)" ]]; then
    check_passed admin_bootstrap_environment
  else
    check_blocked admin_bootstrap_environment "Initialization state or ADMIN_BOOTSTRAP_TOKEN presence could not be verified"
  fi
else
  check_blocked shared_environment "Shared environment file is missing"
fi

probe_runtime=/run/peilv-probe-preflight
register_temp_file "$probe_runtime"
install -d -o root -g root -m 0700 "$probe_runtime"
if [[ -f "$base/shared/app.env" ]] && (
  [[ -x "$curl_secret_helper" ]]
  printf 'url = "http://127.0.0.1:5000/api/storage/health"\nfail\nsilent\nshow-error\n' | RUNTIME_DIRECTORY="$probe_runtime" "$curl_secret_helper" "$internal_secret_file" >/dev/null
); then
  check_passed storage_health
else
  check_blocked storage_health "Production storage health check failed"
fi

join_lines() { local IFS=$'\n'; printf '%s' "$*"; }
STATUS="$([[ ${#blockers[@]} -eq 0 ]] && printf passed || printf blocked)" \
RELEASE_ID="$release_id" COMMIT_SHA="$commit_sha" SOURCE_RUN_ID="$source_run_id" \
SOURCE_RUN_ATTEMPT="$source_run_attempt" SOURCE_ARTIFACT_ID="$source_artifact_id" \
ARCHIVE_SHA="$measured_archive_sha" REQUEST_ID="$request_id" CURRENT_RELEASE="$current_release" \
TARGET_RELEASE="$target_release" BACKUP_PATH="$backup_path" OPT_AVAILABLE_KB="$opt_available_kb" \
TRANSITION_APPROVED="$transition_approved" \
CHECKS="$(join_lines "${checks[@]}")" BLOCKERS="$(join_lines "${blockers[@]}")" \
PENDING="$(join_lines "${pending[@]}")" APPLIED="$(join_lines "${applied_versions[@]}")" \
UNKNOWN="$(join_lines "${unknown[@]}")" VERIFIED_TREE="$verified_tree" node <<'NODE'
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
    headCommitSha: process.env.COMMIT_SHA,
    snapshotSha256: (() => {
      const manifest = JSON.parse(require("node:fs").readFileSync(`${process.env.VERIFIED_TREE}/release-manifest.json`, "utf8"));
      return manifest.snapshotSha256 ?? null;
    })(),
    sourceRunId: Number(process.env.SOURCE_RUN_ID),
    sourceRunAttempt: Number(process.env.SOURCE_RUN_ATTEMPT),
    sourceArtifactId: Number(process.env.SOURCE_ARTIFACT_ID),
    archiveSha256: process.env.ARCHIVE_SHA,
  },
  currentRelease: process.env.CURRENT_RELEASE || null,
  targetReleasePath: process.env.TARGET_RELEASE,
  rollbackRelease: process.env.CURRENT_RELEASE || null,
  approvedCurrentUnitHotfixTransition: process.env.TRANSITION_APPROVED === "1",
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
