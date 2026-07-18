#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(uname -s)" == Linux ]] || { printf 'SKIP: Linux /run permission contract\n'; exit 0; }
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/peilv-curl-test.XXXXXX")"
runtime=/run/peilv
credential_dir=/run/peilv/credentials
credential="$credential_dir/internal-api-secret"
cleanup() { rm -rf -- "$work" "$credential"; rmdir "$credential_dir" "$runtime" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$credential_dir"
chmod 0700 "$runtime" "$credential_dir"
secret='super-secret-value-that-must-not-leak'
printf '%s\n' "$secret" >"$credential"
chmod 0600 "$credential"
cat >"$work/fake-curl" <<'SH'
#!/usr/bin/env sh
printf '%s\n' "$@" >"$ARGV_FILE"
env >"$ENV_FILE"
config="$2"
stat -c '%a' "$config" >"$MODE_FILE"
printf '%s' "$config" >"$CONFIG_PATH_FILE"
SH
chmod 0700 "$work/fake-curl"
export CURL_BIN="$work/fake-curl" ARGV_FILE="$work/argv" ENV_FILE="$work/env"
export MODE_FILE="$work/mode" CONFIG_PATH_FILE="$work/config-path"
unset INTERNAL_API_SECRET TMPDIR
stdout="$work/stdout" stderr="$work/stderr"
printf 'url = "http://127.0.0.1/health"\nsilent\n' | "$root/scripts/lib/curl-secret.sh" "$credential" >"$stdout" 2>"$stderr"
! grep -Fq "$secret" "$ARGV_FILE"
! grep -Fq "$secret" "$ENV_FILE"
! grep -Fq "$secret" "$stdout"
! grep -Fq "$secret" "$stderr"
grep -Fxq -- '--config' "$ARGV_FILE"
grep -Fxq '600' "$MODE_FILE"
config_path="$(cat "$CONFIG_PATH_FILE")"
[[ ! -e "$config_path" ]]

chmod 0644 "$credential"
if printf 'silent\n' | "$root/scripts/lib/curl-secret.sh" "$credential" >/dev/null 2>&1; then exit 1; fi
chmod 0600 "$credential"
ln -s "$credential" "$work/secret-link"
if printf 'silent\n' | "$root/scripts/lib/curl-secret.sh" "$work/secret-link" >/dev/null 2>&1; then exit 1; fi
