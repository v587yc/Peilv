#!/bin/bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$root"
run_id="$(date +%s)$$"; attempt=1; sha=$(git rev-parse HEAD); release_id="r${run_id}-a${attempt}-${sha:0:12}"
archive="release-artifacts/peilv-$release_id.tar.gz"; checksum="$archive.sha256"; external="release-artifacts/release-manifest-$release_id.json"
extract=$(mktemp -d); launcher_pid=''; launcher_native_pid=''; child_pid=''; pid_file="$extract/runtime.pid.json"; stop_file="$extract/runtime.stop"; log_file="$extract/server-$release_id.log"
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"; [[ "$port" -ne 5000 && "$port" -ne 5001 ]]
listener_pids(){
  local p="$1" output
  if command -v powershell.exe >/dev/null 2>&1; then
    { powershell.exe -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique" 2>/dev/null || true; } | tr -d '\r' | sed '/^[[:space:]]*$/d' | sort -n
  elif command -v ss >/dev/null 2>&1; then
    output="$(ss -ltnp "sport = :$p" 2>/dev/null || true)"
    { printf '%s\n' "$output" | grep -oE 'pid=[0-9]+' || true; } | cut -d= -f2 | sort -nu
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -t -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | sort -nu
  else
    printf 'Get-NetTCPConnection, ss, or lsof is required for owner evidence\n' >&2
    return 2
  fi
}
process_exists(){
  local pid="$1"
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "if(Get-Process -Id $pid -ErrorAction SilentlyContinue){exit 0}else{exit 1}" >/dev/null 2>&1
  else kill -0 "$pid" 2>/dev/null; fi
}

validate_child_metadata(){
  [[ -s "$pid_file" ]] || return 1
  node - "$pid_file" "$extract" "$port" <<'NODE'
const fs=require("node:fs"),path=require("node:path");
const data=JSON.parse(fs.readFileSync(process.argv[2],"utf8")),cwd=path.resolve(process.argv[3]),port=Number(process.argv[4]);
if(!Number.isInteger(data.pid)||data.pid<=0||!Number.isInteger(data.launcherPid)||data.launcherPid<=0||path.resolve(data.cwd)!==cwd||path.resolve(data.server)!==path.join(cwd,"server.js")||data.port!==port)process.exit(1);
process.stdout.write(`${data.pid} ${data.launcherPid}`);
NODE
}

stop_runtime(){
  [[ -n "$launcher_pid" ]] || return 0
  local metadata
  if metadata=$(validate_child_metadata); then read -r child_pid launcher_native_pid <<<"$metadata"; : >"$stop_file"; else printf 'Refusing unverified runtime cleanup\n' >&2; return 1; fi
  for _ in {1..80}; do kill -0 "$launcher_pid" 2>/dev/null || break; sleep .1; done
  if kill -0 "$launcher_pid" 2>/dev/null; then kill -TERM "$launcher_pid" 2>/dev/null || true; fi
  wait "$launcher_pid" 2>/dev/null || true; launcher_pid=''
  for _ in {1..50}; do ! process_exists "$child_pid" && ! process_exists "$launcher_native_pid" && break; sleep .1; done
  ! process_exists "$child_pid" && ! process_exists "$launcher_native_pid" && [[ -z "$(listener_pids "$port")" ]]
}

cleanup(){
  local status=$?
  stop_runtime || status=1
  rm -rf -- "$extract"
  rm -f -- "$archive" "$checksum" "$external"
  [[ ! -e "$extract" && ! -e "$archive" && ! -e "$checksum" && ! -e "$external" ]] || status=1
  return "$status"
}
trap cleanup EXIT HUP INT TERM

port5000_before="$(listener_pids 5000)"; port5001_before="$(listener_pids 5001)"
printf 'EVIDENCE {"phase":"before","port5000Pids":"%s","port5001Pids":"%s"}\n' "${port5000_before//$'\n'/,}" "${port5001_before//$'\n'/,}"

bash scripts/create-release.sh "$release_id" "$sha" 1 local/peilv "$run_id" "$attempt" >/dev/null
bash scripts/verify-release.sh "$archive" "$checksum" >/dev/null
archive_sha=$(sha256sum "$archive"|awk '{print $1}')
bash scripts/verify-release.sh --archive "$archive" "$archive_sha" "$extract" "$(basename "$archive")" >/dev/null
bash scripts/verify-release.sh --tree "$extract" >/dev/null
cmp -s infra/systemd/peilv.service "$extract/infra/systemd/peilv.service"
cmp -s scripts/admin-bootstrap.mjs "$extract/scripts/admin-bootstrap.mjs"
for expected in 'HOSTNAME=127.0.0.1' 'PORT=5000' 'DEPLOY_RUN_PORT=5000'; do
  key="${expected%%=*}"
  [[ "$(grep -Ec "^Environment=${key}=" "$extract/infra/systemd/peilv.service")" == 1 ]]
  grep -Fxq "Environment=$expected" "$extract/infra/systemd/peilv.service"
done
! grep -Eq 'Environment=(HOSTNAME=0\.0\.0\.0|PORT=3000|DEPLOY_RUN_PORT=3000)$' "$extract/infra/systemd/peilv.service"
python - "$extract" <<'PYTREE'
import pathlib,stat,sys
for p in pathlib.Path(sys.argv[1]).rglob('*'):
 s=p.lstat()
 if stat.S_ISLNK(s.st_mode) or (not stat.S_ISREG(s.st_mode) and not stat.S_ISDIR(s.st_mode)) or (stat.S_ISREG(s.st_mode) and s.st_nlink != 1): raise SystemExit(1)
PYTREE
if find "$extract" -name '.env*' -print -quit | grep -q .; then exit 1; fi
for forbidden in scripts/rotate-internal-secret.sh scripts/deploy-production.sh scripts/rollback-production.sh scripts/production-preflight.sh scripts/reconcile-automation.sh scripts/dispatch-automation.sh scripts/start.sh; do [[ ! -e "$extract/$forbidden" && ! -L "$extract/$forbidden" ]]; done

env -u NODE_PATH node tests/release-runtime-launcher.mjs "$extract" "$port" "$pid_file" "$stop_file" "$log_file" & launcher_pid=$!
for _ in {1..80}; do [[ -s "$pid_file" ]] && break; kill -0 "$launcher_pid" 2>/dev/null || { printf 'FAIL launcher exited\n' >&2; exit 1; }; sleep .1; done
read -r child_pid launcher_native_pid <<<"$(validate_child_metadata)"
ready=''; for _ in {1..160}; do ready=$(curl -fsS "http://127.0.0.1:$port/api/readiness" 2>/dev/null||true); [[ "$ready" == '{"ready":true}' ]]&&break; kill -0 "$launcher_pid" 2>/dev/null||{ printf 'FAIL runtime exited\n' >&2; exit 1; }; sleep .25; done
[[ "$ready" == '{"ready":true}' ]]
dynamic_owners="$(listener_pids "$port")"
[[ "$dynamic_owners" == "$child_pid" ]] || { printf 'FAIL dynamic port owner mismatch: expected=%s actual=%s\n' "$child_pid" "${dynamic_owners//$'\n'/,}" >&2; exit 1; }
printf 'EVIDENCE {"phase":"ready","releaseId":"%s","port":%s,"launcherPid":%s,"childPid":%s,"ownerPids":"%s"}\n' "$release_id" "$port" "$launcher_native_pid" "$child_pid" "${dynamic_owners//$'\n'/,}"
curl -fsS -D "$extract/readiness.headers" -o "$extract/readiness.body" "http://127.0.0.1:$port/api/readiness"
grep -Eiq '^cache-control:.*no-store' "$extract/readiness.headers"; [[ "$(cat "$extract/readiness.body")" == '{"ready":true}' ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")" == 200 ]]
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/login")" == 200 ]]
stop_runtime; sleep .2; [[ -z "$(listener_pids "$port")" ]]
port5000_after="$(listener_pids 5000)"; port5001_after="$(listener_pids 5001)"
[[ "$port5000_before" == "$port5000_after" && "$port5001_before" == "$port5001_after" ]]
printf 'EVIDENCE {"phase":"after","port":%s,"dynamicOwnerPids":"","childAlive":false,"launcherAlive":false,"port5000Pids":"%s","port5001Pids":"%s"}\n' "$port" "${port5000_after//$'\n'/,}" "${port5001_after//$'\n'/,}"
cleanup; trap - EXIT HUP INT TERM
[[ ! -e "$archive" && ! -e "$checksum" && ! -e "$external" && ! -e "$extract" ]]
printf 'PASS runtime_closure RELEASE_ID=%s CHILD_PID=%s LAUNCHER_PID=%s PORT=%s PORT5000_PIDS=%s PORT5001_PIDS=%s\n' "$release_id" "$child_pid" "$launcher_native_pid" "$port" "${port5000_after//$'\n'/,}" "${port5001_after//$'\n'/,}"
