#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${PEILV_TEST_SANDBOX_ONLY:-}" == 1 ]] || { printf 'sandbox guard missing\n' >&2; exit 97; }
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
[[ "$work" == /tmp/* || "$work" == "${TMPDIR:-/tmp}"/* ]] || exit 98
mkdir -p "$work/fs/a" "$work/fs/b" "$work/bin"
pass_count=0
skip_count=0
pass() { pass_count=$((pass_count + 1)); printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

cat >"$work/bin/stat" <<'SH'
#!/bin/bash
[[ "$1 $2 $3" == "-c %d --" ]] && { printf '%s\n' "${FAKE_DEVICE:-77}"; exit; }
exec /usr/bin/stat "$@"
SH
cat >"$work/bin/df" <<'SH'
#!/bin/bash
case " $* " in
  *" -Pk "*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nmock 999999 1 %s 1%% /mock\n' "${FAKE_BLOCKS:-999999}" ;;
  *" -Pi "*) printf 'Filesystem Inodes IUsed IFree IUse%% Mounted\nmock 999999 1 %s 1%% /mock\n' "${FAKE_INODES:-999999}" ;;
  *) exit 2 ;;
esac
SH
cat >"$work/bin/quota" <<'SH'
#!/bin/bash
[[ "${FAKE_QUOTA_FAIL:-0}" == 0 ]]
SH
chmod +x "$work/bin/"*

run_budget() {
  env PATH="$work/bin:$PATH" FAKE_BLOCKS="${FAKE_BLOCKS:-999999}" FAKE_INODES="${FAKE_INODES:-999999}" FAKE_QUOTA_FAIL="${FAKE_QUOTA_FAIL:-0}" ROOT="$work" \
    bash -c 'source "$1"; deployment_budget_reset; deployment_budget_add "$ROOT/fs/a/new" 10 10 a; deployment_budget_add "$ROOT/fs/b/new" 20 20 b; deployment_budget_check' \
    bash "$repo/scripts/lib/deployment-budget.sh" >/dev/null 2>&1
}
expect_reject() { local label="$1"; shift; if "$@"; then fail "$label accepted"; else pass "$label"; fi; }
FAKE_BLOCKS=100 expect_reject same_filesystem_peak_blocks run_budget
unset FAKE_BLOCKS
FAKE_INODES=100 expect_reject same_filesystem_peak_inodes run_budget
unset FAKE_INODES
FAKE_QUOTA_FAIL=1 expect_reject quota_exhausted run_budget
unset FAKE_QUOTA_FAIL
if command -v flock >/dev/null 2>&1 && [[ "$(uname -s)" == Linux ]]; then
  exec 8>"$work/deploy.lock"; flock -n 8
  expect_reject flock_contended flock -n "$work/deploy.lock" true
  exec 8>&-
else
  skip_count=$((skip_count + 1)); printf 'SKIP flock_contended linux-util-linux-only\n'
fi

# Extract and execute the actual production pre-transaction function.
ROLLBACK="$repo/scripts/rollback-production.sh" OUT="$work/rollback-pretransaction.sh" node <<'NODE'
const fs=require("node:fs");const s=fs.readFileSync(process.env.ROLLBACK,"utf8");
const start=s.indexOf("rollback_candidate_pretransaction() {");if(start<0)process.exit(1);
const rest=s.slice(start),match=rest.match(/^}\r?$/m);if(!match)process.exit(1);
fs.writeFileSync(process.env.OUT,rest.slice(0,match.index+match[0].length)+"\n");
NODE
source "$work/rollback-pretransaction.sh"

run_rollback_fault() (
  set +E
  trap - ERR
  local scenario="$1" calls="$work/formal-$1.log"
  : >"$calls"
  target="$work/target"; target_release_id=r1-a1-aaaaaaaaaaaa; candidate_unit="peilv-candidate-$target_release_id.service"
  candidate_mount=/srv/peilv-candidate; candidate_stage="$work/stage-$scenario"; candidate_started=0; candidate_started_at=now
  mkdir -p "$target" "$candidate_stage"
  formal() { printf '%s\n' "$1" >>"$calls"; }
  systemctl() { formal "systemctl:$*"; return 0; }
  write_transaction_state() { formal "wal:$*"; return 0; }
  mv() { formal "current:$*"; return 0; }
  openresty() { formal "proxy:$*"; return 0; }
  candidate_prepare_stage() { [[ "$scenario" == stage || "$scenario" == ENOSPC ]] && return 1; printf '%s\n' "$candidate_stage"; }
  candidate_start() { [[ "$scenario" == start ]] && return 1; return 0; }
  candidate_pin_netns() { return 0; }
  candidate_wait_ready() { [[ "$scenario" == readiness ]] && return 1; return 0; }
  check_candidate_application() { return 0; }
  journalctl() { [[ "$scenario" == log ]] && printf 'fatal isolated fault\n'; return 0; }
  stop_candidate() { [[ "$scenario" == stop ]] && return 1; return 0; }
  date() { printf 'now\n'; }
  grep() { command grep "$@"; }
  rollback_failure_trap() { local status=$?; (( transaction_started == 0 )) || formal transaction_restore; exit "$status"; }
  transaction_started=0
  trap rollback_failure_trap EXIT
  if [[ "$scenario" == hash ]]; then
    mkdir -p "$work/fake-root/usr/local/libexec/peilv"
  fi
  verify_release() { [[ "$scenario" == hash ]] && return 1; return 0; }
  # The extracted function uses an absolute verifier; rewrite only that command invocation to the controlled verifier function.
  local definition
  definition="$(declare -f rollback_candidate_pretransaction)"
  definition="${definition//\/usr\/local\/libexec\/peilv\/verify-release.sh/verify_release}"
  eval "$definition"
  rollback_candidate_pretransaction
)

for scenario in stage ENOSPC hash start readiness log; do
  status=0
  run_rollback_fault "$scenario" >/dev/null 2>&1 || status=$?
  (( status != 0 )) || fail "rollback_zero_mutation_$scenario accepted"
  [[ ! -s "$work/formal-$scenario.log" ]] || fail "rollback_zero_mutation_$scenario formal mutation"
  pass "rollback_zero_mutation_$scenario calls=0"
done

source "$repo/scripts/lib/candidate-lifecycle.sh"
candidate_validate_unit_release() { :; }
run_stop_fault() (
  set +E
  trap - ERR
  local scenario="$1" stage="$work/$1-stage" unit=test.service release=r1-a1-aaaaaaaaaaaa mount=/srv/peilv-candidate
  mkdir -p "$stage"
  timeout() { shift; "$@"; }
  systemctl() {
    case "$1:$scenario" in
      stop:systemctl_stop_timeout) return 1 ;;
      show:*) case " $* " in
        *" MainPID "*) [[ "$scenario" == MainPID_alive ]] && printf '4242\n' || printf '0\n' ;;
        *" ActiveState "*) [[ "$scenario" == ignore_TERM || "$scenario" == systemctl_stop_timeout ]] && printf 'active\n' || printf 'inactive\n' ;;
        *" Id "*) printf '%s\n' "$unit" ;;
      esac ;;
      kill:*|reset-failed:*) return 0 ;;
    esac
  }
  candidate_wait_inactive() { [[ "$scenario" != ignore_TERM && "$scenario" != systemctl_stop_timeout ]]; }
  mountpoint() { [[ "$scenario" == port_5001_listening || "$scenario" == mount_busy ]]; }
  nsenter() { [[ "$scenario" == port_5001_listening ]] && printf 'LISTEN 0 1 127.0.0.1:5001\n'; return 0; }
  umount() { [[ "$scenario" != mount_busy ]]; }
  candidate_stop_and_release "$unit" "$release" "$mount"
)

for scenario in ignore_TERM systemctl_stop_timeout MainPID_alive port_5001_listening mount_busy; do
  stage="$work/$scenario-stage"; status=0
  run_stop_fault "$scenario" >/dev/null 2>&1 || status=$?
  (( status != 0 )) || fail "$scenario accepted"
  [[ -d "$stage" ]] || fail "$scenario stage removed"
  pass "$scenario stage_preserved=1"
done

printf 'P0_DYNAMIC_PASS total=%d skipped=%d\n' "$pass_count" "$skip_count"
