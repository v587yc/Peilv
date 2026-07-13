#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_id="${1:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
commit_sha="${2:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
repository_id="${3:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
repository="${4:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
source_run_id="${5:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
source_run_attempt="${6:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"

if [[ ! "$release_id" =~ ^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$ ]] ||
   [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]] ||
   [[ "$release_id" != "r${source_run_id}-a${source_run_attempt}-${commit_sha:0:12}" ]] ||
   [[ ! "$repository_id" =~ ^[1-9][0-9]*$ ]] ||
   [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
   [[ ! "$source_run_id" =~ ^[1-9][0-9]*$ ]] ||
   [[ ! "$source_run_attempt" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Invalid release provenance\n' >&2
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
  infra/local-data/compose.yml
  infra/local-data/nginx/default.conf
  migrations/manifest.json
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
mkdir -p "$stage_dir/dist" "$stage_dir/scripts" "$stage_dir/infra/local-data/nginx" "$stage_dir/infra/local-data/sql"
cp dist/server.js "$stage_dir/dist/server.js"
cp package.json pnpm-lock.yaml .npmrc next.config.ts "$stage_dir/"
cp scripts/start.sh scripts/reconcile-automation.sh "$stage_dir/scripts/"
cp infra/local-data/compose.yml "$stage_dir/infra/local-data/compose.yml"
cp infra/local-data/nginx/default.conf "$stage_dir/infra/local-data/nginx/default.conf"
cp infra/local-data/sql/*.sql "$stage_dir/infra/local-data/sql/"

RELEASE_STAGE_DIR="$stage_dir" \
RELEASE_ID="$release_id" \
COMMIT_SHA="$commit_sha" \
REPOSITORY_ID="$repository_id" \
REPOSITORY="$repository" \
SOURCE_RUN_ID="$source_run_id" \
SOURCE_RUN_ATTEMPT="$source_run_attempt" \
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const stageDir = process.env.RELEASE_STAGE_DIR;
const migrationManifest = JSON.parse(fs.readFileSync(path.join(stageDir, "migrations", "manifest.json"), "utf8"));
for (const migration of migrationManifest.migrations) {
  const content = fs.readFileSync(path.join(stageDir, "migrations", migration.file));
  const actual = crypto.createHash("sha256").update(content).digest("hex");
  if (actual !== migration.sha256) throw new Error(`Migration checksum mismatch: ${migration.file}`);
}
const manifest = {
  schemaVersion: 1,
  repositoryId: Number(process.env.REPOSITORY_ID),
  repository: process.env.REPOSITORY,
  commitSha: process.env.COMMIT_SHA,
  releaseId: process.env.RELEASE_ID,
  sourceRunId: Number(process.env.SOURCE_RUN_ID),
  sourceRunAttempt: Number(process.env.SOURCE_RUN_ATTEMPT),
  buildId: fs.readFileSync(path.join(stageDir, ".next", "BUILD_ID"), "utf8").trim(),
  archiveFile: `peilv-${process.env.RELEASE_ID}.tar.gz`,
  archiveSha256: null,
  createdAt: new Date(0).toISOString(),
  migrations: migrationManifest.migrations,
};
fs.writeFileSync(path.join(stageDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
NODE

tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
  -czf "$archive" -C "$stage_dir" .

(
  cd "$output_dir"
  sha256sum "$(basename "$archive")" > "$(basename "$checksum")"
)

archive_sha="$(sha256sum "$archive" | awk '{print $1}')"
RELEASE_MANIFEST="$stage_dir/release-manifest.json" ARCHIVE_SHA="$archive_sha" node <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.RELEASE_MANIFEST, "utf8"));
manifest.archiveSha256 = process.env.ARCHIVE_SHA;
fs.writeFileSync(`${process.env.RELEASE_MANIFEST}.external`, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
cp "$stage_dir/release-manifest.json.external" "$output_dir/release-manifest-$release_id.json"

printf '%s\n' "$archive"
printf '%s\n' "$checksum"
printf '%s\n' "$output_dir/release-manifest-$release_id.json"
