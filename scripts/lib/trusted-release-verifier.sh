#!/usr/bin/env bash

trusted_release_verifier_install_name() {
  local source_name="$1"
  source_name="${source_name#\*}"
  case "$source_name" in
    scripts/lib/openresty-control.sh) printf '%s\n' openresty-control ;;
    scripts/lib/verify-release.sh|scripts/verify-release.sh) printf '%s\n' verify-release.sh ;;
    scripts/lib/release-archive.py|scripts/release-archive.py) printf '%s\n' release-archive.py ;;
    scripts/lib/release-limits.json|scripts/release-limits.json) printf '%s\n' release-limits.json ;;
    scripts/lib/private-copy.mjs|scripts/private-copy.mjs) printf '%s\n' private-copy.mjs ;;
    scripts/lib/candidate-stage.sh) printf '%s\n' candidate-stage.sh ;;
    scripts/lib/candidate-lifecycle.sh) printf '%s\n' candidate-lifecycle.sh ;;
    scripts/lib/deployment-budget.sh) printf '%s\n' deployment-budget.sh ;;
    *) return 1 ;;
  esac
}

normalize_trusted_release_verifier_manifest() {
  local source_manifest="$1" destination_manifest="$2" expected source_name extra install_name
  : >"$destination_manifest"
  while IFS=' ' read -r expected source_name extra; do
    [[ -z "$extra" && "$expected" =~ ^[0-9a-f]{64}$ && "$source_name" != *$'\r'* ]] || return 1
    install_name="$(trusted_release_verifier_install_name "$source_name")" || return 1
    printf '%s %s\n' "$expected" "$install_name" >>"$destination_manifest"
  done <"$source_manifest"
  verify_trusted_release_verifier_manifest "$destination_manifest"
}

verify_trusted_release_verifier_manifest() {
  local manifest="$1" expected file extra
  local -A seen=()
  local -a required=(verify-release.sh release-archive.py release-limits.json private-copy.mjs candidate-stage.sh candidate-lifecycle.sh deployment-budget.sh openresty-control)
  while IFS=' ' read -r expected file extra; do
    [[ -z "$extra" && "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
    case "$file" in verify-release.sh|release-archive.py|release-limits.json|private-copy.mjs|candidate-stage.sh|candidate-lifecycle.sh|deployment-budget.sh|openresty-control) ;; *) return 1 ;; esac
    [[ -z "${seen[$file]+x}" ]] || return 1
    seen["$file"]=1
  done <"$manifest"
  ((${#seen[@]} == 8)) || return 1
  for file in "${required[@]}"; do [[ -n "${seen[$file]+x}" ]] || return 1; done
}

verify_trusted_release_verifier_bundle() {
  local manifest="$1" bundle_dir="$2" expected file mode
  local -a required=(verify-release.sh release-archive.py release-limits.json private-copy.mjs candidate-stage.sh candidate-lifecycle.sh deployment-budget.sh openresty-control)
  [[ -f "$manifest" && ! -L "$manifest" && "$(stat -c '%U:%G:%a:%h' "$manifest")" == root:root:644:1 ]] || return 1
  [[ -d "$bundle_dir" && ! -L "$bundle_dir" && "$(stat -c '%U:%G:%a:%h' "$bundle_dir")" == root:root:755:2 ]] || return 1
  verify_trusted_release_verifier_manifest "$manifest" || return 1
  for file in "${required[@]}"; do
    expected="$(awk -v wanted="$file" '$2==wanted{print $1}' "$manifest")"
    mode=644; [[ "$file" == verify-release.sh || "$file" == release-archive.py || "$file" == private-copy.mjs || "$file" == candidate-stage.sh || "$file" == candidate-lifecycle.sh || "$file" == deployment-budget.sh || "$file" == openresty-control ]] && mode=755
    [[ -f "$bundle_dir/$file" && ! -L "$bundle_dir/$file" && "$(stat -c '%U:%G:%a:%h' "$bundle_dir/$file")" == "root:root:$mode:1" ]] || return 1
    [[ "$(sha256sum "$bundle_dir/$file" | awk '{print $1}')" == "$expected" ]] || return 1
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -Eeuo pipefail
  verify_trusted_release_verifier_bundle "${1:?manifest required}" "${2:?bundle directory required}"
fi
