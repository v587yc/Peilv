#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_id="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"

if [[ ! "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf 'Invalid release ID: %s\n' "$release_id" >&2
  exit 1
fi

cd "$root_dir"

required=(
  .next/BUILD_ID
  dist/server.js
  package.json
  pnpm-lock.yaml
  .npmrc
  next.config.ts
  scripts/start.sh
  scripts/reconcile-automation.sh
)

for path in "${required[@]}"; do
  if [[ ! -f "$path" ]]; then
    printf 'Missing required release file: %s\n' "$path" >&2
    exit 1
  fi
done

if ! compgen -G 'migrations/*.sql' >/dev/null; then
  printf 'No migration files found\n' >&2
  exit 1
fi

output_dir="$root_dir/release-artifacts"
archive="$output_dir/peilv-$release_id.tar.gz"
checksum="$archive.sha256"

mkdir -p "$output_dir"
if [[ -e "$archive" || -e "$checksum" ]]; then
  printf 'Release artifact already exists: %s\n' "$release_id" >&2
  exit 1
fi

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/peilv-release.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT

(
  tar -cf - \
    --exclude='.next/cache' \
    --exclude='.next/dev' \
    --exclude='.next/diagnostics' \
    .next
) | tar -xf - -C "$stage_dir"
cp -a public "$stage_dir/public"
cp -a migrations "$stage_dir/migrations"
mkdir -p "$stage_dir/dist" "$stage_dir/scripts"
cp dist/server.js "$stage_dir/dist/server.js"
cp package.json pnpm-lock.yaml .npmrc next.config.ts "$stage_dir/"
cp scripts/start.sh scripts/reconcile-automation.sh "$stage_dir/scripts/"

tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
  -czf "$archive" -C "$stage_dir" .

(
  cd "$output_dir"
  sha256sum "$(basename "$archive")" > "$(basename "$checksum")"
)

printf '%s\n' "$archive"
printf '%s\n' "$checksum"
