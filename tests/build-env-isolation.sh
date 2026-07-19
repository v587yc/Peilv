#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
workspace="$work/workspace"
mkdir -p "$workspace/scripts" "$workspace/public" "$work/bin"
cp "$root/scripts/build.sh" "$workspace/scripts/build.sh"
printf 'development-only-value\n' >"$workspace/.env"
before_hash="$(sha256sum "$workspace/.env" | awk '{print $1}')"
real_node="$(command -v node)"

cat >"$work/bin/pnpm" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == next && "$2" == build ]]; then
  [[ ! -e .env ]] || { printf 'root env remained visible\n' >&2; exit 91; }
  if [[ "${SIMULATE_NEXT_FAILURE:-0}" == 1 ]]; then exit 92; fi
  if [[ -n "${SIMULATE_SIGNAL:-}" ]]; then kill -s "$SIMULATE_SIGNAL" "$PPID"; sleep 30; fi
  mkdir -p .next/standalone .next/static
  printf build >.next/BUILD_ID
  printf '{}\n' >.next/routes-manifest.json
  printf 'void 0;\n' >.next/standalone/server.js
  printf static >.next/static/app.js
elif [[ "$1" == tsup ]]; then
  mkdir -p dist
  printf 'void 0;\n' >dist/server.js
else
  printf 'unexpected pnpm invocation\n' >&2
  exit 93
fi
FAKE
chmod +x "$work/bin/pnpm"

cat >"$work/bin/node" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == */standalone-runtime-deps.mjs || "${1:-}" == standalone-runtime-deps.mjs ]]; then
  [[ "$#" == 3 ]] || { printf 'unexpected standalone runtime dependency arguments\n' >&2; exit 94; }
  standalone="$2"; workspace="$3"
  [[ "$standalone" == .next/standalone ]] || { printf 'unexpected standalone target: %s\n' "$standalone" >&2; exit 95; }
  [[ "$workspace" == "$COZE_WORKSPACE_PATH" ]] || { printf 'unexpected workspace target: %s\n' "$workspace" >&2; exit 96; }
  for package in next styled-jsx react react-dom; do
    mkdir -p "$standalone/node_modules/$package"
    printf '{"name":"%s","version":"0.0.0-fixture"}\n' "$package" >"$standalone/node_modules/$package/package.json"
  done
  exit 0
fi
exec "$REAL_NODE" "$@"
FAKE
chmod +x "$work/bin/node"

assert_env_restored() {
  local phase="$1"
  [[ -f "$workspace/.env" ]] || { printf 'FAIL source env not restored after %s\n' "$phase" >&2; exit 1; }
  [[ "$(sha256sum "$workspace/.env" | awk '{print $1}')" == "$before_hash" ]] || { printf 'FAIL source env changed after %s\n' "$phase" >&2; exit 1; }
}

run_signaled_build() {
  local signal="$1" status
  set +e
  PATH="$work/bin:$PATH" REAL_NODE="$real_node" COZE_WORKSPACE_PATH="$workspace" SIMULATE_SIGNAL="$signal" \
    bash "$workspace/scripts/build.sh" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || { printf 'FAIL %s build unexpectedly succeeded\n' "$signal" >&2; exit 1; }
  assert_env_restored "$signal"
}

if PATH="$work/bin:$PATH" REAL_NODE="$real_node" COZE_WORKSPACE_PATH="$workspace" SIMULATE_NEXT_FAILURE=1 bash "$workspace/scripts/build.sh" >/dev/null 2>&1; then
  printf 'FAIL simulated build unexpectedly succeeded\n' >&2
  exit 1
fi
assert_env_restored failure

for signal in HUP INT TERM; do run_signaled_build "$signal"; done

PATH="$work/bin:$PATH" REAL_NODE="$real_node" COZE_WORKSPACE_PATH="$workspace" bash "$workspace/scripts/build.sh" >/dev/null
assert_env_restored success
[[ -z "$(find "$workspace/.next/standalone" -name '.env*' -print -quit)" ]] || { printf 'FAIL standalone contains env\n' >&2; exit 1; }
printf 'PASS build_env_isolation_and_restoration\n'
