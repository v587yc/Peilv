#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
workspace_real=""
workspace_parent=""
build_lock=""
build_lock_acquired=0
build_lock_token=""
build_lock_heartbeat_pid=""
env_vault=""
isolated_env_names=()

initialize_build_context() {
  workspace_real="$(cd "$COZE_WORKSPACE_PATH" && pwd -P)"
  [[ -n "$workspace_real" && "$workspace_real" != "/" ]] || { printf 'Refusing unsafe build workspace: %s\n' "$workspace_real" >&2; return 1; }
  workspace_parent="$(cd "$workspace_real/.." && pwd -P)"
  local workspace_lock_hash
  workspace_lock_hash="$(printf '%s' "$workspace_real" | sha256sum | awk '{print $1}')"
  [[ "$workspace_lock_hash" =~ ^[0-9a-f]{64}$ ]] || { printf 'Unable to derive build lock identity\n' >&2; return 1; }
  build_lock="$workspace_parent/.peilv-build-lock-$workspace_lock_hash"
  [[ "$(dirname -- "$build_lock")" == "$workspace_parent" && "$(basename -- "$build_lock")" == ".peilv-build-lock-$workspace_lock_hash" ]] || {
    printf 'Refusing build lock outside canonical parent\n' >&2
    return 1
  }
}

validate_lock_node() {
  [[ ! -L "$build_lock" && -d "$build_lock" ]] || { printf 'Unsafe build lock node: %s\n' "$build_lock" >&2; return 1; }
  local name path
  for name in pid workspace token heartbeat ready; do
    path="$build_lock/$name"
    [[ ! -L "$path" && -f "$path" ]] || { printf 'Unsafe build lock metadata: %s\n' "$path" >&2; return 1; }
  done
  while IFS= read -r -d '' path; do
    name="$(basename -- "$path")"
    case "$name" in pid|workspace|token|heartbeat|ready) ;; *) printf 'Unexpected build lock entry: %s\n' "$path" >&2; return 1;; esac
  done < <(find "$build_lock" -mindepth 1 -maxdepth 1 -print0)
}

remove_validated_lock() {
  validate_lock_node || return 1
  [[ "$(<"$build_lock/workspace")" == "$workspace_real" ]] || { printf 'Build lock workspace mismatch\n' >&2; return 1; }
  rm -f -- "$build_lock/pid" "$build_lock/workspace" "$build_lock/token" "$build_lock/heartbeat" "$build_lock/ready"
  rmdir -- "$build_lock"
}

heartbeat_build_lock() {
  local counter=0
  while :; do
    sleep 1
    [[ -d "$build_lock" && ! -L "$build_lock" && -f "$build_lock/token" && ! -L "$build_lock/token" ]] || return 0
    [[ "$(<"$build_lock/token")" == "$build_lock_token" ]] || return 0
    counter=$((counter + 1))
    printf '%s\n' "$counter" > "$build_lock/heartbeat"
  done
}

release_build_lock() {
  ((build_lock_acquired)) || return 0
  if [[ -n "$build_lock_heartbeat_pid" ]]; then
    kill "$build_lock_heartbeat_pid" 2>/dev/null || true
    wait "$build_lock_heartbeat_pid" 2>/dev/null || true
    build_lock_heartbeat_pid=""
  fi
  validate_lock_node || return 1
  [[ "$(<"$build_lock/token")" == "$build_lock_token" ]] || { printf 'Refusing to release build lock owned by another process\n' >&2; return 1; }
  remove_validated_lock
  build_lock_acquired=0
}

acquire_build_lock() {
  local owner_pid owner_workspace first_heartbeat second_heartbeat waited=0
  local max_wait="${PEILV_BUILD_LOCK_MAX_WAIT_SECONDS:-300}"
  [[ "$max_wait" =~ ^[1-9][0-9]*$ && "$max_wait" -le 3600 ]] || { printf 'Invalid build lock wait bound\n' >&2; return 1; }
  while ! mkdir -- "$build_lock" 2>/dev/null; do
    if [[ -L "$build_lock" || ! -d "$build_lock" ]]; then
      printf 'Unsafe build lock node: %s\n' "$build_lock" >&2
      return 1
    fi
    if [[ ! -e "$build_lock/ready" ]]; then
      if find "$build_lock" -mindepth 1 -maxdepth 1 -type l -print -quit | grep -q .; then
        printf 'Unsafe symlink in build lock metadata\n' >&2
        return 1
      fi
      sleep 1
      waited=$((waited + 1))
      if ((waited >= max_wait)); then
        printf 'Timed out waiting for build lock metadata initialization\n' >&2
        return 1
      fi
      continue
    fi
    validate_lock_node || return 1
    owner_workspace="$(<"$build_lock/workspace")"
    [[ "$owner_workspace" == "$workspace_real" ]] || { printf 'Build lock workspace mismatch\n' >&2; return 1; }
    owner_pid="$(<"$build_lock/pid")"
    [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] || { printf 'Invalid build lock PID\n' >&2; return 1; }
    first_heartbeat="$(<"$build_lock/heartbeat")"
    sleep 1
    waited=$((waited + 1))
    if [[ ! -e "$build_lock" && ! -L "$build_lock" ]]; then
      continue
    fi
    validate_lock_node || return 1
    second_heartbeat="$(<"$build_lock/heartbeat")"
    if [[ "$first_heartbeat" != "$second_heartbeat" ]]; then
      if ((waited >= max_wait)); then
        printf 'Timed out waiting for verified active build lock (pid %s)\n' "$owner_pid" >&2
        return 1
      fi
      printf 'Waiting for another verified build in this workspace (pid %s)...\n' "$owner_pid" >&2
      continue
    fi
    if ((waited >= max_wait)); then
      printf 'Timed out waiting for stale or unverifiable build lock (recorded pid %s); refusing automatic cleanup\n' "$owner_pid" >&2
      return 1
    fi
    printf 'Build lock heartbeat is static and process identity is unverifiable; waiting fail-closed (recorded pid %s)\n' "$owner_pid" >&2
  done
  build_lock_token="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  [[ "$build_lock_token" =~ ^[0-9a-f]{64}$ ]] || { printf 'Unable to create build lock owner token\n' >&2; rmdir -- "$build_lock"; return 1; }
  umask 077
  printf '%s\n' "$$" > "$build_lock/pid"
  printf '%s\n' "$workspace_real" > "$build_lock/workspace"
  printf '%s\n' "$build_lock_token" > "$build_lock/token"
  printf '0\n' > "$build_lock/heartbeat"
  printf 'ready\n' > "$build_lock/ready"
  build_lock_acquired=1
  (trap - EXIT HUP INT TERM; heartbeat_build_lock) &
  build_lock_heartbeat_pid=$!
}

prepare_standalone_output() {
  local standalone_dir standalone_real expected_real
  expected_real="$workspace_real/.next/standalone"
  standalone_dir="$COZE_WORKSPACE_PATH/.next/standalone"
  if [[ ! -e "$standalone_dir" && ! -L "$standalone_dir" ]]; then
    return 0
  fi
  [[ -d "$standalone_dir" && ! -L "$standalone_dir" ]] || {
    printf 'Refusing to clean unsafe standalone output: %s\n' "$standalone_dir" >&2
    return 1
  }
  standalone_real="$(realpath "$standalone_dir")"
  [[ "$standalone_real" == "$expected_real" ]] || {
    printf 'Refusing to clean standalone output outside workspace: %s\n' "$standalone_real" >&2
    return 1
  }
  rm -rf -- "$standalone_dir"
}

restore_local_env_files() {
  local name
  [[ -n "$env_vault" && -d "$env_vault" ]] || return 0
  for name in "${isolated_env_names[@]}"; do
    if [[ -e "$COZE_WORKSPACE_PATH/$name" || -L "$COZE_WORKSPACE_PATH/$name" ]]; then
      printf 'Refusing to overwrite environment file created during build: %s\n' "$name" >&2
      return 1
    fi
    mv -- "$env_vault/$name" "$COZE_WORKSPACE_PATH/$name"
  done
  rmdir "$env_vault"
  env_vault=""
}

isolate_local_env_files() {
  local path name
  shopt -s nullglob
  local candidates=("$COZE_WORKSPACE_PATH"/.env*)
  shopt -u nullglob
  ((${#candidates[@]})) || return 0
  umask 077
  env_vault="$(mktemp -d "$workspace_parent/.peilv-build-env.XXXXXX")"
  chmod 700 "$env_vault" 2>/dev/null || true
  for path in "${candidates[@]}"; do
    [[ -f "$path" && ! -L "$path" ]] || { printf 'Unsafe root environment entry: %s\n' "$(basename "$path")" >&2; return 1; }
  done
  for path in "${candidates[@]}"; do
    name="$(basename "$path")"
    mv -- "$path" "$env_vault/$name"
    isolated_env_names+=("$name")
  done
}

on_exit() {
  local original_status=$? cleanup_status=0 step_status=0
  trap - EXIT
  restore_local_env_files || {
    step_status=$?
    cleanup_status=$step_status
    printf 'Build cleanup failed while restoring environment files\n' >&2
  }
  release_build_lock || {
    step_status=$?
    ((cleanup_status == 0)) && cleanup_status=$step_status
    printf 'Build cleanup failed while releasing the workspace lock\n' >&2
  }
  if ((original_status != 0)); then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}

main() {
  initialize_build_context
  trap on_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  cd "${COZE_WORKSPACE_PATH}"
  acquire_build_lock
  prepare_standalone_output
  isolate_local_env_files

echo "Building the Next.js project..."
pnpm next build

if find .next/standalone -name '.env*' -print -quit | grep -q .; then
  printf 'Build rejected: Next standalone contains an environment file\n' >&2
  exit 1
fi

while IFS= read -r -d '' source_map; do
  map_name="$(basename "$source_map")"
  if grep -RIlF --include='*.js' --include='*.css' -- "$map_name" .next/static | grep -q .; then
    printf 'Build rejected: emitted source map is referenced at runtime: %s\n' "$map_name" >&2
    exit 1
  fi
  rm -- "$source_map"
done < <(find .next/static -type f -name '*.map' -print0)

echo "Bundling server with tsup..."
pnpm tsup src/server.ts --format cjs --platform node --target node22 --outDir dist --no-splitting --no-minify

test -f .next/BUILD_ID
test -f .next/routes-manifest.json
test -f dist/server.js
test -f .next/standalone/server.js
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static .next/standalone/public
cp .next/BUILD_ID .next/routes-manifest.json .next/standalone/.next/
cp -a .next/static .next/standalone/.next/static
cp -a public .next/standalone/public
node scripts/standalone-runtime-deps.mjs .next/standalone "$COZE_WORKSPACE_PATH"

# Next ships shell-quote as build tooling inside its precompiled distribution,
# but the production server does not use it. Keep build-only tooling out of the
# deployable standalone closure.
rm -rf .next/standalone/node_modules/next/dist/compiled/shell-quote

STANDALONE_ROOT="$COZE_WORKSPACE_PATH/.next/standalone" node <<'NODE'
const { createRequire } = require("node:module");
const path = require("node:path");
const root = path.resolve(process.env.STANDALONE_ROOT);
const runtimeRequire = createRequire(path.join(root, "server.js"));
for (const name of ["next", "styled-jsx", "react", "react-dom"]) {
  const resolved = runtimeRequire.resolve(`${name}/package.json`);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Runtime dependency resolved outside standalone: ${name}`);
}
NODE

if find .next/standalone -name '.env*' -print -quit | grep -q .; then
  printf 'Build rejected: assembled standalone contains an environment file\n' >&2
  exit 1
fi
if find .next/standalone -type f -name '*.map' -print -quit | grep -q .; then
  printf 'Build rejected: assembled standalone contains a source map\n' >&2
  exit 1
fi
for forbidden_root in release-artifacts test-results playwright-report blob-report coverage .claude .trellis; do
  if [[ -e ".next/standalone/$forbidden_root" || -L ".next/standalone/$forbidden_root" ]]; then
    printf 'Build rejected: assembled standalone contains local-only path: %s\n' "$forbidden_root" >&2
    exit 1
  fi
done
if find .next/standalone -mindepth 1 -maxdepth 1 -name '.test-tmp*' -print -quit | grep -q .; then
  printf 'Build rejected: assembled standalone contains a local test path\n' >&2
  exit 1
fi
for forbidden_dependency in react-dev-inspector react-dev-utils shell-quote; do
  if find .next/standalone -iname "*$forbidden_dependency*" -print -quit | grep -q .; then
    printf 'Build rejected: assembled standalone contains forbidden dependency: %s\n' "$forbidden_dependency" >&2
    exit 1
  fi
done

  echo "Build completed successfully!"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
