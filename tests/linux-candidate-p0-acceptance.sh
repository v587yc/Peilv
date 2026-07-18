#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly UNIT_PREFIX="peilv-p0-test-"
readonly FIXTURE_REL="tests/fixtures/linux-p0/mock-rollback-transaction.sh"
readonly UNIT_GUARD_REL="tests/fixtures/linux-p0/unit-loadstate-guard.sh"
ack=0; root_mode=varlib; repo_root=""; sandbox_root=""; loop_image=""; loop_device=""; loop_mount=""; unit=""
busy_pid=""; lock_holder_pid=""; pass_count=0; fail_count=0; skip_count=0; total_count=0; cleanup_started=0; unit_created=0

json_string(){
  local v="${1-}"
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  v=${v//$'\n'/\\n}
  printf '"%s"' "$v"
}
emit(){ printf '{"type":%s,"name":%s,"status":%s,"detail":%s}\n' "$(json_string "$1")" "$(json_string "$2")" "$(json_string "$3")" "$(json_string "${4-}")"; }
pass(){ total_count=$((total_count+1)); pass_count=$((pass_count+1)); emit test "$1" PASS "${2-}"; }
fail(){ total_count=$((total_count+1)); fail_count=$((fail_count+1)); emit test "$1" FAIL "$2"; }
skip(){ total_count=$((total_count+1)); skip_count=$((skip_count+1)); emit test "$1" SKIP "$2"; }
usage(){ printf '%s\n' 'Usage: sudo PEILV_LINUX_P0_SANDBOX_ONLY=1 tests/linux-candidate-p0-acceptance.sh --isolated-host-ack [--root-mode=varlib|loopback]'; }

safe_names(){
  [[ -z "$unit" || "$unit" == "$UNIT_PREFIX"*.service ]]
  [[ -z "$sandbox_root" || "$sandbox_root" == /var/lib/peilv-test-* || "$sandbox_root" == /tmp/peilv-test-*-root ]]
  [[ -z "$loop_mount" || "$loop_mount" == /tmp/peilv-test-*-root ]]
  [[ -z "$loop_image" || "$loop_image" == /tmp/peilv-test-*.img ]]
}
cleanup(){
  local incoming=$? rc=0 target; local -a targets=()
  (( cleanup_started == 0 )) || return "$incoming"; cleanup_started=1; trap - EXIT HUP INT TERM
  safe_names || { emit cleanup boundary FAIL 'tracked resource escaped test namespace'; return 120; }
  [[ -z "$lock_holder_pid" ]] || { kill "$lock_holder_pid" 2>/dev/null || :; wait "$lock_holder_pid" 2>/dev/null || :; }
  [[ -z "$busy_pid" ]] || { kill -KILL "$busy_pid" 2>/dev/null || :; wait "$busy_pid" 2>/dev/null || :; }
  if (( unit_created == 1 )); then systemctl kill --kill-who=all --signal=SIGKILL "$unit" >/dev/null 2>&1 || :; systemctl stop "$unit" >/dev/null 2>&1 || :; systemctl reset-failed "$unit" >/dev/null 2>&1 || :; fi
  if [[ -n "$sandbox_root" ]]; then
    mapfile -t targets < <(findmnt -rn -o TARGET 2>/dev/null | awk -v root="$sandbox_root/" 'index($0,root)==1' | sort -r)
    for target in "${targets[@]}"; do [[ "$target" == "$sandbox_root/"* ]] && umount "$target" >/dev/null 2>&1 || rc=1; done
  fi
  if [[ -n "$loop_mount" ]] && mountpoint -q "$loop_mount"; then umount "$loop_mount" >/dev/null 2>&1 || rc=1; fi
  [[ -z "$loop_device" ]] || losetup -d "$loop_device" >/dev/null 2>&1 || rc=1
  [[ -z "$sandbox_root" ]] || rm -rf --one-file-system -- "$sandbox_root" 2>/dev/null || rc=1
  [[ -z "$loop_mount" ]] || rmdir "$loop_mount" 2>/dev/null || :
  [[ -z "$loop_image" ]] || rm -f -- "$loop_image" 2>/dev/null || rc=1
  (( incoming == 0 && rc != 0 )) && return 121; return "$incoming"
}
trap cleanup EXIT HUP INT TERM

static_self_scan(){
  local token; local -a forbidden=()
  forbidden+=("peilv"'.service' "peilv"'-dispatch.timer' "peilv"'-reconcile.timer')
  forbidden+=('/opt/'"peilv"'/' '/var/lib/'"peilv"'/' '/etc/'"openresty" '/var/lib/'"postgresql")
  for token in "${forbidden[@]}"; do LC_ALL=C grep -Fq -- "$token" "${BASH_SOURCE[0]}" && { emit guard static_self_scan FAIL 'forbidden production marker detected'; return 99; }; done
  emit guard static_self_scan PASS 'production markers absent'
}
for arg in "$@"; do case "$arg" in --isolated-host-ack) ack=1;; --root-mode=varlib) root_mode=varlib;; --root-mode=loopback) root_mode=loopback;; -h|--help) usage; exit 0;; *) usage >&2; exit 98;; esac; done
static_self_scan
[[ "${PEILV_LINUX_P0_SANDBOX_ONLY:-}" == 1 ]] || { emit guard environment FAIL 'PEILV_LINUX_P0_SANDBOX_ONLY=1 required'; exit 97; }
(( ack == 1 )) || { emit guard isolated_host_ack FAIL '--isolated-host-ack required'; exit 97; }
[[ "$EUID" == 0 && "$(uname -s)" == Linux && -d /run/systemd/system && -f /sys/fs/cgroup/cgroup.controllers ]] || { emit guard linux_systemd_root FAIL 'root, Linux, systemd and cgroup v2 required'; exit 97; }
for cmd in systemctl systemd-run nsenter curl ss flock findmnt mountpoint mount umount timeout awk grep sort mktemp od tr python3; do command -v "$cmd" >/dev/null || { emit guard dependency FAIL "$cmd required"; exit 97; }; done
if [[ "$root_mode" == loopback ]]; then for cmd in losetup mkfs.ext4 truncate; do command -v "$cmd" >/dev/null || { emit guard dependency FAIL "$cmd required"; exit 97; }; done; fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ -x "$repo_root/$FIXTURE_REL" && -r "$repo_root/$UNIT_GUARD_REL" ]] || { emit guard fixture FAIL 'fixture or unit guard unavailable'; exit 97; }
source "$repo_root/$UNIT_GUARD_REL"
source "$repo_root/scripts/lib/candidate-lifecycle.sh"
random_id="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"; unit="${UNIT_PREFIX}${random_id}.service"
if ! p0_unique_unit_is_absent "$unit"; then emit guard unique_unit FAIL 'random unit LoadState is present or unreliable'; exit 97; fi
emit guard unique_unit PASS "$unit"
if [[ "$root_mode" == varlib ]]; then sandbox_root="$(mktemp -d /var/lib/peilv-test-XXXXXXXX)"; else
  loop_image="/tmp/peilv-test-${random_id}.img"; loop_mount="/tmp/peilv-test-${random_id}-root"; truncate -s 96M "$loop_image"
  loop_device="$(losetup --find --show "$loop_image")"; mkfs.ext4 -q -N 2048 "$loop_device"; mkdir -m 0700 "$loop_mount"; mount -o nosuid,nodev "$loop_device" "$loop_mount"; sandbox_root="$loop_mount"
fi
safe_names || exit 97
mkdir -p "$sandbox_root"/{bin,locks,mount-source,mount-busy,preflight,quarantine,run,sensitive/{shared,backups,releases,incoming},optional/docker.sock}
emit guard sandbox_root PASS "$root_mode isolated root"
cat >"$sandbox_root/bin/private-server.py" <<'PY_SERVER'
import http.server, signal
signal.signal(signal.SIGTERM, lambda *_: None)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b=b'{"ready":true}\n'; self.send_response(200); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self,*_): pass
http.server.ThreadingHTTPServer(('127.0.0.1',5001),H).serve_forever()
PY_SERVER

ss -lntH 'sport = :5001' | grep -q . && { emit guard host_port_5001 FAIL 'already occupied'; exit 97; }
CANDIDATE_REQUIRED_SENSITIVE_PATHS=("$sandbox_root/sensitive/shared" "$sandbox_root/sensitive/backups" "$sandbox_root/sensitive/releases" "$sandbox_root/sensitive/incoming")
CANDIDATE_OPTIONAL_SENSITIVE_PATHS=("$sandbox_root/optional/docker.sock" "$sandbox_root/optional/postgresql" "$sandbox_root/optional/containerd" "$sandbox_root/optional/dbus")
candidate_existing_sensitive_path_properties sensitive_path_properties
systemd-run --quiet --unit="$unit" --property=Type=simple --property=PrivateNetwork=yes --property=PrivateTmp=yes --property=NoNewPrivileges=yes --property=MemoryMax=64M --property=MemorySwapMax=0 --property=TasksMax=32 --property=CPUQuota=25% --property=LimitNOFILE=256 --property="ReadWritePaths=$sandbox_root" "${sensitive_path_properties[@]}" --working-directory="$sandbox_root" /usr/bin/python3 "$sandbox_root/bin/private-server.py"
unit_created=1
for _ in {1..50}; do pid="$(systemctl show "$unit" -p MainPID --value)"; [[ "$pid" =~ ^[1-9][0-9]*$ ]] && nsenter -t "$pid" -n -- ss -lntH 'sport = :5001' | grep -q . && break; sleep .1; done
pid="$(systemctl show "$unit" -p MainPID --value)"
[[ "$pid" =~ ^[1-9][0-9]*$ ]] && pass optional_sensitive_missing_start 'missing postgresql/containerd/dbus paths did not block startup' || fail optional_sensitive_missing_start 'transient unit failed to start'
inaccessible_paths="$(systemctl show "$unit" -p InaccessiblePaths --value)"
[[ "$inaccessible_paths" == *"$sandbox_root/optional/docker.sock"* && "$inaccessible_paths" != *"$sandbox_root/optional/postgresql"* && "$inaccessible_paths" != *"$sandbox_root/optional/containerd"* && "$inaccessible_paths" != *"$sandbox_root/optional/dbus"* ]] && pass optional_sensitive_properties 'only existing optional path was emitted' || fail optional_sensitive_properties "$inaccessible_paths"
nsenter -t "$pid" -m -- test ! -e "$sandbox_root/optional/docker.sock" && pass optional_sensitive_existing_blocked 'existing optional socket path inaccessible' || fail optional_sensitive_existing_blocked 'existing optional socket path visible'
required_blocked=1
for path in "${CANDIDATE_REQUIRED_SENSITIVE_PATHS[@]}"; do nsenter -t "$pid" -m -- test ! -e "$path" || required_blocked=0; done
(( required_blocked == 1 )) && pass required_sensitive_paths_blocked 'shared/backups/releases/incoming inaccessible' || fail required_sensitive_paths_blocked 'a required business path remained visible'
curl --max-time 1 -fsS http://127.0.0.1:5001/api/readiness >/dev/null 2>&1 && fail private_network_host_unreachable 'host reached private listener' || pass private_network_host_unreachable 'host cannot reach 5001'
nsenter -t "$pid" -n -- curl --max-time 2 -fsS http://127.0.0.1:5001/api/readiness | grep -Fq '"ready":true' && pass private_network_nsenter_reachable 'namespace readiness works' || fail private_network_nsenter_reachable 'namespace readiness failed'
property_equals(){ local got; got="$(systemctl show "$unit" -p "$1" --value)"; [[ "$got" == "$2" ]] && pass "systemd_property_$1" "$got" || fail "systemd_property_$1" "expected=$2 actual=$got"; }
property_equals PrivateNetwork yes; property_equals PrivateTmp yes; property_equals NoNewPrivileges yes; property_equals MemoryMax 67108864; property_equals MemorySwapMax 0; property_equals TasksMax 32; property_equals LimitNOFILE 256; property_equals CPUQuotaPerSecUSec 250ms
control_group="$(systemctl show "$unit" -p ControlGroup --value)"; [[ "$control_group" == /* && -d "/sys/fs/cgroup$control_group" ]] || { fail cgroup_path invalid; exit 1; }
cgroup_equals(){ local got; got="$(<"/sys/fs/cgroup$control_group/$1")"; [[ "$got" == "$2" ]] && pass "cgroup_${1//./_}" "$got" || fail "cgroup_${1//./_}" "expected=$2 actual=$got"; }
cgroup_equals memory.max 67108864; cgroup_equals memory.swap.max 0; cgroup_equals pids.max 32
cpu_max="$(<"/sys/fs/cgroup$control_group/cpu.max")"
[[ "$cpu_max" =~ ^25000[[:space:]]+100000$ ]] && pass cgroup_cpu_max "$cpu_max" || fail cgroup_cpu_max "$cpu_max"

lock="$sandbox_root/locks/transaction.lock"
( exec 9>"$lock"; flock -n 9; printf ready >"$sandbox_root/run/lock-ready"; sleep 30 ) & lock_holder_pid=$!
for _ in {1..50}; do [[ -f "$sandbox_root/run/lock-ready" ]] && break; sleep .05; done
( exec 8>"$lock"; flock -n 8 ) && fail flock_transaction_two_rejected 'second acquired lock' || pass flock_transaction_two_rejected 'second rejected'
kill "$lock_holder_pid"; wait "$lock_holder_pid" 2>/dev/null || :; lock_holder_pid=""
( exec 8>"$lock"; flock -n 8 ) && pass flock_transaction_two_after_release 'second succeeds after release' || fail flock_transaction_two_after_release 'lock remained held'

mkdir -p "$sandbox_root/bin/capacity"
cat >"$sandbox_root/bin/capacity/df" <<'DF_FIXTURE'
#!/usr/bin/env bash
case " $* " in
  *' -Pk '*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nmock 100 99 %s 99%% /isolated\n' "${P0_BLOCKS:-1}" ;;
  *' -Pi '*) printf 'Filesystem Inodes IUsed IFree IUse%% Mounted\nmock 100 99 %s 99%% /isolated\n' "${P0_INODES:-1}" ;;
  *) exit 2 ;;
esac
DF_FIXTURE
cat >"$sandbox_root/bin/capacity/quota" <<'QUOTA_FIXTURE'
#!/usr/bin/env bash
[[ "${P0_QUOTA_OK:-1}" == 1 ]]
QUOTA_FIXTURE
chmod 0700 "$sandbox_root/bin/capacity/"*
capacity_gate(){
  local blocks inodes
  blocks="$(PATH="$sandbox_root/bin/capacity:$PATH" df -Pk -- "$sandbox_root" | awk 'NR==2{print $4}')"
  inodes="$(PATH="$sandbox_root/bin/capacity:$PATH" df -Pi -- "$sandbox_root" | awk 'NR==2{print $4}')"
  (( blocks >= $1 && inodes >= $2 )) && PATH="$sandbox_root/bin/capacity:$PATH" quota -w -u root >/dev/null
}
P0_BLOCKS=1 P0_INODES=100 P0_QUOTA_OK=1 capacity_gate 2 2 && fail capacity_blocks accepted || pass capacity_blocks rejected
P0_BLOCKS=100 P0_INODES=1 P0_QUOTA_OK=1 capacity_gate 2 2 && fail capacity_inodes accepted || pass capacity_inodes rejected
P0_BLOCKS=100 P0_INODES=100 P0_QUOTA_OK=0 capacity_gate 2 2 && fail capacity_quota accepted || pass capacity_quota rejected

formal="$sandbox_root/bin/formal-mutation"
cat >"$formal" <<'FORMAL_FIXTURE'
#!/usr/bin/env bash
value="$(<"$1")"; printf '%s\n' "$((value+1))" >"$1"
FORMAL_FIXTURE
chmod 0700 "$formal"
for fault in stage enospc hash start readiness log; do
  counter="$sandbox_root/run/$fault.count"; printf '0\n' >"$counter"
  if P0_FAULT="$fault" P0_FORMAL_COUNTER="$counter" P0_FORMAL_COMMAND="$formal" "$repo_root/$FIXTURE_REL" >/dev/null 2>&1; then
    fail "rollback_${fault}_zero_formal_mutations" crossed
  elif [[ "$(<"$counter")" == 0 ]]; then
    pass "rollback_${fault}_zero_formal_mutations" 'formal command count=0'
  else
    fail "rollback_${fault}_zero_formal_mutations" "count=$(<"$counter")"
  fi
done
verified="$sandbox_root/preflight/verified.tree"
mkdir -p "$verified/nested"; : >"$verified/nested/file"; rm -rf --one-file-system -- "$verified"
[[ ! -e "$verified" ]] && pass preflight_recursive_cleanup removed || fail preflight_recursive_cleanup remains
release="$sandbox_root/preflight/release.failed"; quarantine="$sandbox_root/quarantine/release.failed"
mkdir "$release"; : >"$release/payload"; mv -T "$release" "$quarantine"; : >"$quarantine/QUARANTINED"
[[ -f "$quarantine/payload" && -f "$quarantine/QUARANTINED" && ! -e "$release" ]] && pass preflight_quarantine atomic || fail preflight_quarantine invalid

timeout 1s systemctl stop "$unit" && fail stubborn_term 'TERM stopped process' || pass stubborn_term 'TERM timed out'
pid_after_term="$(systemctl show "$unit" -p MainPID --value)"
[[ "$pid_after_term" =~ ^[1-9][0-9]*$ ]] && pass stubborn_mainpid_alive "$pid_after_term" || fail stubborn_mainpid_alive "$pid_after_term"
nsenter -t "$pid_after_term" -n -- ss -lntH 'sport = :5001' | grep -q . && pass stubborn_port_5001_busy listening || fail stubborn_port_5001_busy closed
mount --bind "$sandbox_root/mount-source" "$sandbox_root/mount-busy"
( cd "$sandbox_root/mount-busy"; exec sleep 30 ) & busy_pid=$!; sleep .1
umount "$sandbox_root/mount-busy" 2>/dev/null && fail stubborn_mount_busy unmounted || pass stubborn_mount_busy blocked
kill -KILL "$busy_pid"; wait "$busy_pid" 2>/dev/null || :; busy_pid=""; umount "$sandbox_root/mount-busy"
systemctl kill --kill-who=all --signal=SIGKILL "$unit"
for _ in {1..50}; do [[ "$(systemctl show "$unit" -p MainPID --value)" == 0 ]] && break; sleep .1; done
[[ "$(systemctl show "$unit" -p MainPID --value)" == 0 ]] && pass stubborn_sigkill_mainpid_zero cleared || fail stubborn_sigkill_mainpid_zero alive
nsenter -t "$pid_after_term" -n -- ss -lntH 'sport = :5001' 2>/dev/null | grep -q . && fail stubborn_sigkill_port_closed listening || pass stubborn_sigkill_port_closed closed
systemctl reset-failed "$unit" >/dev/null 2>&1 || :

cleanup_rc=0; cleanup || cleanup_rc=$?
(( cleanup_rc == 0 )) && pass cleanup_resources removed || fail cleanup_resources "rc=$cleanup_rc"
overall=PASS; (( fail_count == 0 )) || overall=FAIL
emit summary linux_candidate_p0 "$overall" "PASS=$pass_count FAIL=$fail_count SKIP=$skip_count TOTAL=$total_count"
printf '%s PASS=%d FAIL=%d SKIP=%d TOTAL=%d\n' "$overall" "$pass_count" "$fail_count" "$skip_count" "$total_count"
(( fail_count == 0 ))
