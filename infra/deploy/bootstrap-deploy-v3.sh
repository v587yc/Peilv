#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "$(id -u)" == 0 ]] || { printf 'Root is required\n' >&2; exit 1; }
[[ "$#" == 1 && -d "$1" && ! -L "$1" ]] || { printf 'Usage: bootstrap-deploy-v3.sh <trusted-staging-directory>\n' >&2; exit 1; }
stage="$(readlink -f "$1")"
lock_file="${PEILV_TCB_LOCK:-/run/lock/peilv-deploy-tcb.lock}"
exec 9>"$lock_file"; flock -n 9 || { printf 'Another TCB activation is running\n' >&2; exit 1; }

sbin="${PEILV_TCB_SBIN:-/usr/local/sbin}"; libexec="${PEILV_TCB_LIBEXEC:-/usr/local/libexec/peilv}"
etc="${PEILV_TCB_ETC:-/etc/peilv}"; sudoers_dir="${PEILV_TCB_SUDOERS:-/etc/sudoers.d}"
install -d -o root -g root -m 0755 "$sbin" "$libexec" "$etc" "$sudoers_dir"
manifest_sha='e9c0380879cd8485644f4075cb1e000c60dab3c997120109d1ee5e6d9cf6099e'
sudoers_sha='99d3210b02a66ae156530b8e139a9a7ee18c3946ea4317b506d41a5b7c204a90'
declare -a names=(deploy-production.sh migration-contract.mjs deploy-operation-ledger.mjs peilv-control peilv-sudoers trusted-deploy-v2.sha256)
declare -A destinations=(
  [deploy-production.sh]="$libexec/deploy-production.sh" [migration-contract.mjs]="$libexec/migration-contract.mjs"
  [deploy-operation-ledger.mjs]="$libexec/deploy-operation-ledger.mjs" [peilv-control]="$sbin/peilv-control"
  [peilv-sudoers]="$sudoers_dir/peilv" [trusted-deploy-v2.sha256]="$etc/trusted-deploy-v2.sha256"
)
declare -A modes=([deploy-production.sh]=755 [migration-contract.mjs]=755 [deploy-operation-ledger.mjs]=755 [peilv-control]=755 [peilv-sudoers]=440 [trusted-deploy-v2.sha256]=644)
for name in "${names[@]}"; do
  source="$stage/$name"; [[ -f "$source" && ! -L "$source" && "$(stat -c '%U:%G:%h' "$source")" == root:root:1 ]] || { printf 'Unsafe staged TCB object: %s\n' "$name" >&2; exit 1; }
  [[ "$(stat -c %a "$source")" == "${modes[$name]}" ]] || { printf 'Wrong staged TCB mode: %s\n' "$name" >&2; exit 1; }
  [[ "$(stat -c %d "$source")" == "$(stat -c %d "$(dirname "${destinations[$name]}")")" ]] || { printf 'TCB staging must share the destination filesystem: %s\n' "$name" >&2; exit 1; }
  LC_ALL=C grep -q $'\r' "$source" && { printf 'CRLF is forbidden in TCB object: %s\n' "$name" >&2; exit 1; } || true
done
(cd "$stage"; sha256sum -c trusted-deploy-v2.sha256 --strict)
[[ "$(sha256sum "$stage/trusted-deploy-v2.sha256"|awk '{print $1}')" == "$manifest_sha" ]]
[[ "$(sha256sum "$stage/peilv-sudoers"|awk '{print $1}')" == "$sudoers_sha" ]]
bash -n "$stage/peilv-control"; bash -n "$stage/deploy-production.sh"
node --check "$stage/migration-contract.mjs"; node --check "$stage/deploy-operation-ledger.mjs"
visudo -cf "$stage/peilv-sudoers"

declare -A backups=()
activated=(); restore() { local status=$? name target backup; trap - EXIT; for ((i=${#activated[@]}-1;i>=0;i--)); do name="${activated[$i]}"; target="${destinations[$name]}"; backup="${backups[$name]}"; rm -f "$target"; [[ ! -e "$backup" ]] || mv "$backup" "$target"; sync -f "$(dirname "$target")"; done; for name in "${names[@]}"; do rm -f "${destinations[$name]}.next-v3" "${destinations[$name]}.old-v3-$$"; done; exit "$status"; }; trap restore EXIT
for name in "${names[@]}"; do target="${destinations[$name]}"; install -o root -g root -m "${modes[$name]}" "$stage/$name" "$target.next-v3"; sync -f "$target.next-v3"; done
# Per-file rename is atomic. Manifest-last means every mixed generation is rejected by peilv-control.
for name in deploy-production.sh migration-contract.mjs deploy-operation-ledger.mjs peilv-control peilv-sudoers trusted-deploy-v2.sha256; do
  target="${destinations[$name]}"; backups["$name"]="$target.old-v3-$$"; [[ ! -e "$target" ]] || mv "$target" "${backups[$name]}"; mv "$target.next-v3" "$target"; activated+=("$name"); sync -f "$(dirname "$target")"
  [[ "${PEILV_TCB_FAIL_AFTER:-}" != "$name" ]] || { printf 'Injected activation failure after %s\n' "$name" >&2; false; }
done
trap - EXIT
for name in "${names[@]}"; do rm -f "${backups[$name]:-}"; done
printf 'Deploy v3 Host TCB activated atomically\n'
