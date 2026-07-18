#!/usr/bin/env bash
set -Eeuo pipefail
work="$(mktemp -d "${TMPDIR:-/tmp}/peilv-p0-loadstate-matrix-XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/unit-loadstate-guard.sh"
unit=peilv-p0-test-0123456789abcdef.service
mkdir -p "$work/bin"
cat >"$work/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
unit="${2-}"
case "${P0_LOADSTATE_CASE:?}" in
  exit0_not_found) printf 'not-found\n'; exit 0 ;;
  exit4_not_found) printf 'not-found\n'; exit 4 ;;
  exit4_empty) exit 4 ;;
  exit4_exact_stderr) printf 'Unit %s could not be found.\n' "$unit" >&2; exit 4 ;;
  exit1_exact_stderr) printf 'Unit %s could not be found.\n' "$unit" >&2; exit 1 ;;
  exit4_wrong_unit_stderr) printf 'Unit peilv-p0-test-ffffffffffffffff.service could not be found.\n' >&2; exit 4 ;;
  exit4_exact_stderr_extra) printf 'Unit %s could not be found.\nextra\n' "$unit" >&2; exit 4 ;;
  exit4_stdout_and_stderr) printf 'not-found\n'; printf 'Unit %s could not be found.\n' "$unit" >&2; exit 4 ;;
  loaded) printf 'loaded\n'; exit 0 ;;
  masked) printf 'masked\n'; exit 0 ;;
  error) printf 'error\n'; exit 0 ;;
  bad_setting) printf 'bad-setting\n'; exit 0 ;;
  stub) printf 'stub\n'; exit 0 ;;
  merged) printf 'merged\n'; exit 0 ;;
  multiline) printf 'not-found\nloaded\n'; exit 0 ;;
  trailing_blank) printf 'not-found\n\n'; exit 0 ;;
  unknown) printf 'mystery\n'; exit 0 ;;
  exit1_garbage) printf '\033[31mnot-found\033[0m\n'; exit 1 ;;
  exit0_non_ascii) printf '\377not-found\n'; exit 0 ;;
  exit0_nul) printf 'not-\0found\n'; exit 0 ;;
  exit1_empty) exit 1 ;;
  exit0_empty) exit 0 ;;
  *) exit 125 ;;
esac
MOCK
chmod 0700 "$work/bin/systemctl"
run_case() {
  local name="$1" expected="$2" actual=reject
  if PATH="$work/bin:$PATH" P0_LOADSTATE_CASE="$name" p0_unique_unit_is_absent "$unit"; then actual=allow; fi
  [[ "$actual" == "$expected" ]] || { printf 'FAIL %s expected=%s actual=%s\n' "$name" "$expected" "$actual" >&2; return 1; }
  printf 'PASS %s %s\n' "$name" "$actual"
}
run_case exit0_not_found allow
run_case exit4_not_found allow
run_case exit4_exact_stderr allow
run_case exit4_empty reject
run_case exit1_exact_stderr reject
run_case exit4_wrong_unit_stderr reject
run_case exit4_exact_stderr_extra reject
run_case exit4_stdout_and_stderr reject
run_case exit0_empty reject
run_case exit1_empty reject
run_case loaded reject
run_case masked reject
run_case error reject
run_case bad_setting reject
run_case stub reject
run_case merged reject
run_case multiline reject
run_case trailing_blank reject
run_case unknown reject
run_case exit1_garbage reject
run_case exit0_non_ascii reject
run_case exit0_nul reject
PATH="$work/bin:$PATH" P0_LOADSTATE_CASE=exit0_not_found p0_unique_unit_is_absent peilv-p0-test-bad.service && { printf 'FAIL malformed unit allowed\n' >&2; exit 1; } || printf 'PASS malformed_unit reject\n'
printf 'PASS unit_loadstate_matrix total=23\n'
