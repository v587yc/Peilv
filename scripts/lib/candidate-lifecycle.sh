#!/usr/bin/env bash

CANDIDATE_RUNTIME_MAX_SEC="${PEILV_CANDIDATE_RUNTIME_MAX_SEC:-120}"
CANDIDATE_MEMORY_MAX="${PEILV_CANDIDATE_MEMORY_MAX:-768M}"
CANDIDATE_TASKS_MAX="${PEILV_CANDIDATE_TASKS_MAX:-128}"
CANDIDATE_CPU_QUOTA="${PEILV_CANDIDATE_CPU_QUOTA:-100%}"
CANDIDATE_NOFILE="${PEILV_CANDIDATE_NOFILE:-4096}"
CANDIDATE_TMP_SIZE="${PEILV_CANDIDATE_TMP_SIZE:-64M}"
CANDIDATE_NETNS_ROOT="${PEILV_CANDIDATE_NETNS_ROOT:-/run/peilv-candidate-netns}"
CANDIDATE_REQUIRED_SENSITIVE_PATHS=(
  /opt/peilv/shared
  /opt/peilv/backups
  /opt/peilv/releases
  /opt/peilv/incoming
)
CANDIDATE_OPTIONAL_SENSITIVE_PATHS=(
  /etc/peilv
  /var/lib/peilv
  /run/docker.sock
  /run/containerd
  /run/dbus
  /run/systemd/private
  /run/postgresql
)

candidate_existing_sensitive_path_properties() {
  local output_name="$1" path
  local -n output="$output_name"
  output=()
  for path in "${CANDIDATE_REQUIRED_SENSITIVE_PATHS[@]}"; do
    if [[ ! -e "$path" ]]; then
      printf 'Required candidate-sensitive path is missing: %s\n' "$path" >&2
      return 1
    fi
    output+=(--property="InaccessiblePaths=$path")
  done
  for path in "${CANDIDATE_OPTIONAL_SENSITIVE_PATHS[@]}"; do
    [[ -e "$path" ]] && output+=(--property="InaccessiblePaths=$path")
  done
  return 0
}

candidate_validate_unit_release() {
  local unit="$1" release_id="$2"
  [[ "$release_id" =~ ^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$ ]]
  [[ "$unit" == "peilv-candidate-$release_id.service" ]]
}

candidate_main_pid() {
  local unit="$1" release_id="$2" id state pid control_group
  candidate_validate_unit_release "$unit" "$release_id" || return 1
  id="$(systemctl show "$unit" -p Id --value)"
  state="$(systemctl show "$unit" -p ActiveState --value)"
  pid="$(systemctl show "$unit" -p MainPID --value)"
  control_group="$(systemctl show "$unit" -p ControlGroup --value)"
  [[ "$id" == "$unit" && "$state" == active && "$pid" =~ ^[1-9][0-9]*$ && "$pid" -gt 1 ]]
  [[ -d "/proc/$pid" && -r "/proc/$pid/cgroup" && -n "$control_group" ]]
  grep -Fq -- "$control_group" "/proc/$pid/cgroup"
  printf '%s\n' "$pid"
}

candidate_pin_netns() {
  local unit="$1" release_id="$2" pid pin
  pid=""
  for _ in {1..30}; do pid="$(candidate_main_pid "$unit" "$release_id" 2>/dev/null || true)"; [[ -n "$pid" ]] && break; sleep 1; done
  [[ "$pid" =~ ^[1-9][0-9]*$ ]]
  install -d -o root -g root -m 0700 -- "$CANDIDATE_NETNS_ROOT"
  pin="$CANDIDATE_NETNS_ROOT/$release_id.net"
  [[ ! -e "$pin" && ! -L "$pin" ]]
  install -o root -g root -m 0600 /dev/null "$pin"
  mount --bind "/proc/$pid/ns/net" "$pin"
  [[ "$(findmnt -n -o FSTYPE --target "$pin")" == nsfs ]]
  printf '%s\n' "$pin"
}

candidate_probe() {
  local unit="$1" release_id="$2" port="${3:-5001}" pid response code headers body
  [[ "$port" == 5001 ]]
  pid="$(candidate_main_pid "$unit" "$release_id")"
  for path in / /login; do
    code="$(nsenter -t "$pid" -n -- curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$path")"
    [[ "$code" == 200 ]] || { printf 'Candidate probe failed: %s returned HTTP %s\n' "$path" "$code" >&2; return 1; }
  done
  headers="$(mktemp)"; body="$(mktemp)"
  code="$(nsenter -t "$pid" -n -- curl -sS -D "$headers" -o "$body" -w '%{http_code}' "http://127.0.0.1:$port/api/readiness")"
  if [[ "$code" != 200 ]]; then printf 'Candidate probe failed: /api/readiness returned HTTP %s\n' "$code" >&2; rm -f "$headers" "$body"; return 1; fi
  if ! grep -Eiq '^Cache-Control:[[:space:]]*([^\r]*,)?[[:space:]]*no-store([,;[:space:]]|\r?$)' "$headers"; then printf 'Candidate probe failed: /api/readiness is missing no-store\n' >&2; rm -f "$headers" "$body"; return 1; fi
  response="$(cat "$body")"
  rm -f "$headers" "$body"
  RESPONSE="$response" /usr/bin/node -e 'const value=JSON.parse(process.env.RESPONSE);if(value.ready!==true||Object.keys(value).length!==1)process.exit(1)'
}

candidate_start() {
  local unit="$1" release_id="$2" stage="$3" candidate_mount="$4"
  local -a sensitive_path_properties=()
  candidate_validate_unit_release "$unit" "$release_id"
  [[ "$stage" == "/var/lib/peilv/candidate-stage/$release_id" && ! -L "$stage" && -d "$stage" ]]
  [[ "$candidate_mount" == /srv/peilv-candidate ]]
  candidate_existing_sensitive_path_properties sensitive_path_properties || return 1
  systemd-run --unit="$unit" --uid=peilv-candidate --gid=peilv-candidate --working-directory="$candidate_mount" \
    --property="SupplementaryGroups=" --property="PrivateNetwork=yes" \
    --property="RuntimeMaxSec=${CANDIDATE_RUNTIME_MAX_SEC}s" --property="MemoryMax=$CANDIDATE_MEMORY_MAX" \
    --property="MemorySwapMax=0" --property="TasksMax=$CANDIDATE_TASKS_MAX" --property="CPUQuota=$CANDIDATE_CPU_QUOTA" \
    --property="LimitNOFILE=$CANDIDATE_NOFILE" --property="PrivateTmp=yes" \
    --property="TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=$CANDIDATE_TMP_SIZE" \
    --property="StandardOutput=journal" --property="StandardError=journal" \
    --property="LogRateLimitIntervalSec=10s" --property="LogRateLimitBurst=200" \
    --property="RuntimeDirectory=peilv-candidate-$release_id" --property="RuntimeDirectoryMode=0700" \
    --property="NoNewPrivileges=yes" --property="CapabilityBoundingSet=" --property="AmbientCapabilities=" \
    --property="PrivateDevices=yes" --property="ProtectSystem=strict" --property="ProtectHome=yes" \
    --property="ProtectProc=invisible" --property="ProcSubset=pid" --property="ProtectKernelTunables=yes" \
    --property="ProtectKernelModules=yes" --property="ProtectKernelLogs=yes" --property="ProtectControlGroups=yes" \
    --property="ProtectClock=yes" --property="ProtectHostname=yes" --property="RestrictSUIDSGID=yes" \
    --property="LockPersonality=yes" --property="RestrictRealtime=yes" --property="SystemCallArchitectures=native" \
    --property="RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
    --property="IPAddressDeny=any" --property="IPAddressAllow=localhost" --property="BindReadOnlyPaths=$stage:$candidate_mount" \
    "${sensitive_path_properties[@]}" \
    /usr/bin/env -i NODE_ENV=production HOSTNAME=127.0.0.1 PORT=5001 DEPLOY_RUN_PORT=5001 /usr/bin/node server.js >/dev/null
}

candidate_wait_ready() {
  local unit="$1" release_id="$2"
  for _ in {1..30}; do
    if candidate_main_pid "$unit" "$release_id" >/dev/null 2>&1 && candidate_probe "$unit" "$release_id" 5001 >/dev/null 2>&1; then return 0; fi
    [[ "$(systemctl show "$unit" -p ActiveState --value 2>/dev/null)" == failed ]] && break
    sleep 1
  done
  return 1
}

candidate_load_state() {
  local unit="$1" state status=0
  state="$(systemctl show "$unit" -p LoadState --value 2>/dev/null)" || status=$?
  case "$state:$status" in
    loaded:0|not-found:0|not-found:4) printf '%s\n' "$state" ;;
    *) return 1 ;;
  esac
}

candidate_wait_inactive() {
  local unit="$1" attempts="${2:-20}" state load_state
  for ((i=0; i<attempts; i++)); do
    load_state="$(candidate_load_state "$unit")" || return 1
    [[ "$load_state" == not-found ]] && return 0
    [[ "$load_state" == loaded ]] || return 1
    state="$(systemctl show "$unit" -p ActiveState --value 2>/dev/null)" || return 1
    [[ "$state" == inactive || "$state" == failed ]] && return 0
    sleep 1
  done
  return 1
}

candidate_stop_and_release() {
  local unit="$1" release_id="$2" candidate_mount="$3" pin
  local load_state state pid control_group evidence
  pin="$CANDIDATE_NETNS_ROOT/$release_id.net"
  candidate_validate_unit_release "$unit" "$release_id"
  [[ "$candidate_mount" == /srv/peilv-candidate ]]
  load_state="$(candidate_load_state "$unit")" || return 1
  [[ "$load_state" == loaded || "$load_state" == not-found ]] || return 1
  if [[ "$load_state" == loaded ]]; then
    if ! timeout 20s systemctl stop "$unit"; then
      systemctl kill --kill-who=all --signal=SIGKILL "$unit" || return 1
    fi
    if ! candidate_wait_inactive "$unit" 15; then
      systemctl kill --kill-who=all --signal=SIGKILL "$unit" || return 1
      candidate_wait_inactive "$unit" 15 || return 1
    fi
  fi
  load_state="$(candidate_load_state "$unit")" || return 1
  [[ "$load_state" == loaded || "$load_state" == not-found ]] || return 1
  if [[ "$load_state" == loaded ]]; then
    state="$(systemctl show "$unit" -p ActiveState --value 2>/dev/null)" || return 1
    pid="$(systemctl show "$unit" -p MainPID --value 2>/dev/null)" || return 1
    control_group="$(systemctl show "$unit" -p ControlGroup --value 2>/dev/null)" || return 1
    [[ "$state" == inactive || "$state" == failed ]] || return 1
  else
    pid="$(systemctl show "$unit" -p MainPID --value 2>/dev/null || true)"
    control_group="$(systemctl show "$unit" -p ControlGroup --value 2>/dev/null || true)"
  fi
  [[ -n "$pid" ]] || pid=0
  [[ "$pid" == 0 ]] || return 1
  evidence="$(ps -eo pid=,cgroup= 2>/dev/null | grep -F -- "$unit" || true)"
  [[ -z "$evidence" && -z "$control_group" ]] || return 1
  if mountpoint -q "$pin"; then
    if nsenter --net="$pin" -- ss -lntH 'sport = :5001' | grep -q .; then return 1; fi
  fi
  if ! mountpoint -q "$pin" && ss -lntH 'sport = :5001' 2>/dev/null | grep -q .; then return 1; fi
  if mountpoint -q "$pin"; then umount "$pin" || return 1; fi
  ! mountpoint -q "$pin" || return 1
  [[ ! -e "$pin" || ! -L "$pin" ]] && rm -f -- "$pin"
  [[ ! -e "$pin" && ! -L "$pin" ]] || return 1
  ! mountpoint -q "$candidate_mount" || return 1
  ! mountpoint -q "/var/lib/peilv/candidate-stage/$release_id" || return 1
  evidence="$(findmnt -rn -o TARGET,SOURCE 2>/dev/null | grep -F -- "$release_id" || true)"
  [[ -z "$evidence" ]] || return 1
  if [[ "$load_state" == loaded ]]; then systemctl reset-failed "$unit" >/dev/null 2>&1 || :; fi
}
