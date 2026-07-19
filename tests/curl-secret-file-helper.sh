#!/bin/bash
set -Euo pipefail
stage=bootstrap
work=''
cleanup() { [[ -z "$work" ]] || rm -rf -- "$work"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS %s\n' "$1"; }
skip() { printf 'SKIP %s\n' "$1"; }
trap cleanup EXIT
trap 'stage=signal_hup; fail "$stage"' HUP
trap 'stage=signal_int; fail "$stage"' INT
trap 'stage=signal_term; fail "$stage"' TERM

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || fail cwd
[[ -f "$root/scripts/lib/curl-secret.sh" ]] || fail cwd
pass cwd
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) platform=windows_msys ;; *) platform=posix ;; esac
pass platform_detection

work="$(mktemp -d)" || fail temp_workspace
[[ -d "$work" ]] || fail temp_workspace
pass temp_workspace
secret='File_Secret_0123456789abcdefABCDEF'
printf '%s\n' "$secret" >"$work/credential" || fail credential_create
chmod 0600 "$work/credential" || fail credential_chmod
credential_mode="$(stat -c '%a' "$work/credential")" || fail credential_stat
if [[ "$platform" == posix ]]; then
  [[ "$credential_mode" == 600 ]] || fail credential_mode_0600
  pass credential_mode_0600
else
  skip credential_mode_0600_windows
fi

cat >"$work/fake-curl" <<'FAKE'
#!/bin/sh
set -eu
printf '%s\n' "$@" >"$ARGV_OUT"
env >"$ENV_OUT"
config=''
while [ "$#" -gt 0 ]; do [ "$1" = --config ] && { shift; config="$1"; break; }; shift; done
[ -n "$config" ]
stat -c '%a' "$config" >"$MODE_OUT"
printf '%s' "$config" >"$PATH_OUT"
grep -F 'header = "x-internal-api-secret: File_Secret_0123456789abcdefABCDEF"' "$config" >/dev/null
FAKE
chmod +x "$work/fake-curl" || fail curl_bin_setup
[[ -x "$work/fake-curl" ]] || fail curl_bin_setup
pass curl_bin_setup

export INTERNAL_API_SECRET='Poison_Environment_0123456789ABCDEF'
export INTERNAL_API_SECRET_FILE='/poison/path/that/must/not/reach/curl'
helper="$work/curl-secret.sh"
sed "s#case \"\$runtime_dir\" in /run/peilv-\*|/run/peilv)#case \"\$runtime_dir\" in $work/runtime)#; s#/run/credentials/\*|/run/peilv/credentials/\*|/opt/peilv/shared/credentials/internal-api-secret#$work/credential|$work/link#" "$root/scripts/lib/curl-secret.sh" >"$helper" || fail helper_fixture
if [[ "$platform" == windows_msys ]]; then
  sed -i 's/400|600)/400|600|644)/' "$helper" || fail helper_fixture
fi
chmod +x "$helper" || fail helper_fixture
mkdir "$work/runtime" || fail runtime_directory
export RUNTIME_DIRECTORY="$work/runtime"
if [[ "$platform" == posix ]]; then
  chmod 0700 "$work/runtime" || fail runtime_mode_0700
  [[ "$(stat -c '%a' "$work/runtime")" == 700 ]] || fail runtime_mode_0700
  pass runtime_mode_0700
else
  skip runtime_mode_0700_windows
fi
pass helper_fixture

export CURL_BIN="$work/fake-curl" ARGV_OUT="$work/argv" ENV_OUT="$work/env" MODE_OUT="$work/mode" PATH_OUT="$work/path"
stdout="$work/stdout"; stderr="$work/stderr"
if ! printf 'url = "http://127.0.0.1/health"\nsilent\n' | "$helper" "$work/credential" >"$stdout" 2>"$stderr"; then fail helper_execution; fi
pass helper_execution
[[ -s "$work/argv" && -s "$work/env" && -s "$work/path" ]] || fail curl_bin_capture
pass curl_bin_capture

config_path="$(cat "$work/path")" || fail config_path_capture
[[ "$config_path" == "$work"/* ]] || fail msys_path_conversion
pass msys_path_conversion
if [[ "$platform" == posix ]]; then
  [[ "$(cat "$work/mode")" == 600 ]] || fail config_mode_0600
  pass config_mode_0600
else
  skip config_mode_0600_windows
fi
[[ ! -e "$config_path" ]] || fail config_cleanup
pass config_cleanup

if grep -F "$secret" "$work/argv" "$work/env" "$stdout" "$stderr" >/dev/null; then fail secret_output_scrub; fi
pass secret_output_scrub
if grep -F 'Poison_Environment_0123456789ABCDEF' "$work/argv" "$work/env" "$stdout" "$stderr" >/dev/null; then fail poison_env_scrub; fi
if grep -F 'INTERNAL_API_SECRET=' "$work/env" >/dev/null; then fail poison_env_scrub; fi
if grep -F 'INTERNAL_API_SECRET_FILE=' "$work/env" >/dev/null; then fail poison_env_scrub; fi
pass poison_env_scrub

if [[ "$platform" == posix ]]; then
  chmod 0640 "$work/credential" || fail credential_broad_mode
  if printf 'url = "http://127.0.0.1/health"\n' | "$helper" "$work/credential" >/dev/null 2>&1; then fail credential_broad_mode; fi
  chmod 0600 "$work/credential" || fail credential_broad_mode
  pass credential_broad_mode
  ln -s "$work/credential" "$work/link" || fail credential_symlink
  [[ -L "$work/link" ]] || fail credential_symlink
  if printf 'url = "http://127.0.0.1/health"\n' | "$helper" "$work/link" >/dev/null 2>&1; then fail credential_symlink; fi
  pass credential_symlink
  mv "$work/runtime" "$work/runtime-real" || fail runtime_symlink
  ln -s "$work/runtime-real" "$work/runtime" || fail runtime_symlink
  if printf 'url = "http://127.0.0.1/health"\n' | "$helper" "$work/credential" >/dev/null 2>&1; then fail runtime_symlink; fi
  pass runtime_symlink
else
  skip credential_broad_mode_windows
  if ln -s "$work/credential" "$work/link" 2>/dev/null && [[ -L "$work/link" ]]; then
    if printf 'url = "http://127.0.0.1/health"\n' | "$helper" "$work/link" >/dev/null 2>&1; then fail credential_symlink; fi
    pass credential_symlink
  else
    skip credential_symlink_windows
  fi
  skip runtime_symlink_windows
fi
pass complete
