#!/bin/bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT HUP INT TERM
materializer="$root/scripts/release-materialize.mjs"
[[ -f "$materializer" ]] || { printf 'FAIL materializer_missing\n' >&2; exit 1; }
probe="$work/probe"; printf x >"$probe"; ln -s "$probe" "$work/probe-link" 2>/dev/null || true
if [[ ! -L "$work/probe-link" ]]; then printf 'SKIP symlink_semantics_windows\n'; exit 0; fi
make_base(){ local name="$1"; mkdir -p "$work/$name/source/node_modules/.pnpm/pkg@1/node_modules/pkg" "$work/$name/output"; printf trusted >"$work/$name/source/node_modules/.pnpm/pkg@1/node_modules/pkg/index.js"; }
make_base trusted
ln -s '.pnpm/pkg@1/node_modules/pkg' "$work/trusted/source/node_modules/pkg"
node "$materializer" "$work/trusted/source" "$work/trusted/output" "$work/trusted" >/dev/null
[[ -f "$work/trusted/output/node_modules/pkg/index.js" && ! -L "$work/trusted/output/node_modules/pkg" ]]
! find "$work/trusted/output" -type l -o \( ! -type f ! -type d \) | grep -q .
printf 'PASS trusted_pnpm_link_materialized\n'
for scenario in outside dangling cycle; do
  make_base "$scenario"
  case "$scenario" in
    outside) printf evil >"$work/outside.js"; ln -s "$work/outside.js" "$work/$scenario/source/node_modules/pkg" ;;
    dangling) ln -s '.pnpm/missing@1/node_modules/pkg' "$work/$scenario/source/node_modules/pkg" ;;
    cycle) ln -s cycle-b "$work/$scenario/source/node_modules/cycle-a"; ln -s cycle-a "$work/$scenario/source/node_modules/cycle-b" ;;
  esac
  if node "$materializer" "$work/$scenario/source" "$work/$scenario/output" "$work/$scenario" >/dev/null 2>&1; then printf 'FAIL accepted_%s\n' "$scenario" >&2; exit 1; fi
  printf 'PASS rejected_%s\n' "$scenario"
done
