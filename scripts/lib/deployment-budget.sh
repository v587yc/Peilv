#!/usr/bin/env bash

DEPLOYMENT_MIN_MARGIN_KIB="${PEILV_DEPLOYMENT_MIN_MARGIN_KIB:-262144}"
DEPLOYMENT_MIN_MARGIN_INODES="${PEILV_DEPLOYMENT_MIN_MARGIN_INODES:-1024}"
DEPLOYMENT_SYSTEMD_KIB="${PEILV_DEPLOYMENT_SYSTEMD_KIB:-16384}"
declare -Ag DEPLOY_BUDGET_KIB=() DEPLOY_BUDGET_INODES=() DEPLOY_BUDGET_PATH=()

deployment_archive_measure() {
  local archive="$1"
  [[ -f "$archive" && ! -L "$archive" ]]
  /usr/bin/python3 - "$archive" <<'PY'
import sys, tarfile
size=count=0
with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive:
        if member.isfile(): size += member.size; count += 1
        elif member.isdir(): count += 1
print((size + 1023)//1024, count)
PY
}

deployment_budget_reset() { DEPLOY_BUDGET_KIB=(); DEPLOY_BUDGET_INODES=(); DEPLOY_BUDGET_PATH=(); }

deployment_budget_add() {
  local path="$1" kib="$2" inodes="$3" label="$4" parent device
  [[ "$kib" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ && -n "$label" ]]
  parent="$path"; while [[ ! -e "$parent" ]]; do parent="$(dirname "$parent")"; done
  [[ ! -L "$parent" ]]
  device="$(stat -c '%d' -- "$parent")"
  DEPLOY_BUDGET_KIB[$device]=$(( ${DEPLOY_BUDGET_KIB[$device]:-0} + kib ))
  DEPLOY_BUDGET_INODES[$device]=$(( ${DEPLOY_BUDGET_INODES[$device]:-0} + inodes ))
  DEPLOY_BUDGET_PATH[$device]="$parent"
}

deployment_budget_check() {
  local device path planned_kib planned_inodes margin_kib required_kib required_inodes free_kib free_inodes
  for device in "${!DEPLOY_BUDGET_KIB[@]}"; do
    path="${DEPLOY_BUDGET_PATH[$device]}"; planned_kib="${DEPLOY_BUDGET_KIB[$device]}"; planned_inodes="${DEPLOY_BUDGET_INODES[$device]}"
    margin_kib=$((planned_kib / 4)); (( margin_kib >= DEPLOYMENT_MIN_MARGIN_KIB )) || margin_kib="$DEPLOYMENT_MIN_MARGIN_KIB"
    required_kib=$((planned_kib + margin_kib)); required_inodes=$((planned_inodes + DEPLOYMENT_MIN_MARGIN_INODES))
    free_kib="$(df -Pk -- "$path" | awk 'NR==2{print $4}')"; free_inodes="$(df -Pi -- "$path" | awk 'NR==2{print $4}')"
    [[ "$free_kib" =~ ^[0-9]+$ && "$free_inodes" =~ ^[0-9]+$ ]]
    (( free_kib >= required_kib )) || { printf 'Deployment budget ENOSPC on %s: need %s KiB, have %s KiB\n' "$path" "$required_kib" "$free_kib" >&2; return 1; }
    (( free_inodes >= required_inodes )) || { printf 'Deployment budget inode exhaustion on %s: need %s, have %s\n' "$path" "$required_inodes" "$free_inodes" >&2; return 1; }
    if command -v quota >/dev/null 2>&1; then
      quota -w -u root >/dev/null || { printf 'Deployment quota check failed on %s\n' "$path" >&2; return 1; }
    fi
  done
}

deployment_database_estimate_kib() {
  local explicit="${PEILV_DB_BACKUP_ESTIMATE_KIB:-}" measured
  if [[ -n "$explicit" ]]; then [[ "$explicit" =~ ^[1-9][0-9]*$ ]]; printf '%s\n' "$explicit"; return; fi
  measured="$(docker exec local-data-postgres-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select ceil(pg_database_size(current_database())/1024.0)::bigint"')"
  [[ "$measured" =~ ^[1-9][0-9]*$ ]] || { printf 'Set PEILV_DB_BACKUP_ESTIMATE_KIB to a conservative value\n' >&2; return 1; }
  printf '%s\n' "$measured"
}
