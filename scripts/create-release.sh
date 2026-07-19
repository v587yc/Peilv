#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_id="${1:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
commit_sha="${2:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
repository_id="${3:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
repository="${4:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
source_run_id="${5:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
source_run_attempt="${6:?Usage: create-release.sh <release-id> <commit-sha> <repository-id> <repository> <run-id> <run-attempt>}"
source_state="${SOURCE_STATE:-commit}"
snapshot_sha256="${SNAPSHOT_SHA256:-}"

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
if [[ "$source_state" != commit && "$source_state" != snapshot ]] ||
   { [[ "$source_state" == snapshot ]] && [[ ! "$snapshot_sha256" =~ ^[0-9a-f]{64}$ ]]; }; then
  printf 'Invalid source state provenance\n' >&2
  exit 1
fi

cd "$root_dir"
command -v node >/dev/null || { printf 'node is required\n' >&2; exit 1; }
if python3 -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null 2>&1; then python_command=(python3); elif py -3 -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null 2>&1; then python_command=(py -3); else printf 'Python 3.9+ is required\n' >&2; exit 1; fi
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }
archive_tool_native="$(native_path "$root_dir/scripts/release-archive.py")"

required_files=(
  .next/BUILD_ID
  .next/routes-manifest.json
  .next/standalone/server.js
  .next/standalone/.next/BUILD_ID
  .next/standalone/.next/routes-manifest.json
  .next/standalone/package.json
  scripts/admin-bootstrap.mjs
  scripts/run-migrations.mjs
  infra/local-data/compose.yml
  infra/local-data/nginx/default.conf
  infra/openresty/peilv.conf
  infra/systemd/peilv.service
  infra/systemd/peilv-reconcile.service
  infra/systemd/peilv-reconcile.timer
  infra/systemd/peilv-dispatch.service
  infra/systemd/peilv-dispatch.timer
  migrations/manifest.json
)

required_dirs=(
  .next/standalone/.next/static
  .next/standalone/public
)

for path in "${required_files[@]}"; do
  if [[ ! -f "$path" || -L "$path" ]]; then
    printf 'Missing required release file: %s\n' "$path" >&2
    exit 1
  fi
done

for path in "${required_dirs[@]}"; do
  if [[ ! -d "$path" || -L "$path" ]] || [[ -z "$(find "$path" -type f -print -quit)" ]]; then
    printf 'Missing or empty required release directory: %s\n' "$path" >&2
    exit 1
  fi
done

if find .next/standalone -name '.env*' -print -quit | grep -q .; then
  printf 'Standalone contains a forbidden environment file\n' >&2
  exit 1
fi

allowed_release_script_paths=(scripts/admin-bootstrap.mjs scripts/run-migrations.mjs)
forbidden_release_paths=(
  scripts/start.sh scripts/reconcile-automation.sh scripts/dispatch-automation.sh scripts/rotate-internal-secret.sh
  scripts/deploy-production.sh scripts/production-preflight.sh scripts/rollback-production.sh
  scripts/create-release.sh scripts/verify-release.sh scripts/release-materialize.mjs scripts/release-archive.py
  scripts/private-copy.mjs scripts/lib
)
for path in "${forbidden_release_paths[@]}"; do
  [[ ! -e ".next/standalone/$path" && ! -L ".next/standalone/$path" ]] || { printf 'Standalone contains forbidden operational path: %s\n' "$path" >&2; exit 1; }
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

node "$root_dir/scripts/release-materialize.mjs" "$root_dir/.next/standalone" "$stage_dir" "$root_dir"
cp -a migrations "$stage_dir/migrations"
mkdir -p "$stage_dir/infra/local-data/nginx" "$stage_dir/infra/local-data/sql" "$stage_dir/infra/openresty" "$stage_dir/infra/systemd"
cp infra/local-data/compose.yml "$stage_dir/infra/local-data/compose.yml"
cp infra/local-data/nginx/default.conf "$stage_dir/infra/local-data/nginx/default.conf"
cp infra/openresty/peilv.conf infra/openresty/peilv-1panel-http.conf infra/openresty/peilv-1panel-root.conf "$stage_dir/infra/openresty/"
cp infra/systemd/peilv.service infra/systemd/peilv-reconcile.service infra/systemd/peilv-reconcile.timer infra/systemd/peilv-dispatch.service infra/systemd/peilv-dispatch.timer "$stage_dir/infra/systemd/"
cp infra/local-data/sql/*.sql "$stage_dir/infra/local-data/sql/"
SOURCE_CLI="$root_dir/scripts/admin-bootstrap.mjs" TARGET_CLI="$stage_dir/scripts/admin-bootstrap.mjs" node <<'NODE'
const fs = require("node:fs"), path = require("node:path");
const source = process.env.SOURCE_CLI, target = process.env.TARGET_CLI;
const before = fs.lstatSync(source);
if (!before.isFile() || before.isSymbolicLink() || before.nlink < 1) throw new Error("admin bootstrap CLI source must be a regular non-symlink file");
fs.mkdirSync(path.dirname(target), { recursive: true });
const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let output;
try {
  const opened = fs.fstatSync(input);
  if (!opened.isFile() || opened.nlink < 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("admin bootstrap CLI source changed before copy");
  output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, opened.mode & 0o777);
  const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0;
  while (true) { const count = fs.readSync(input, buffer, 0, buffer.length, position); if (!count) break; let written = 0; while (written < count) written += fs.writeSync(output, buffer, written, count - written); position += count; }
  fs.fsyncSync(output);
  const after = fs.fstatSync(input), copied = fs.fstatSync(output);
  for (const key of ["dev", "ino", "size", "ctimeMs", "mtimeMs", "mode", "nlink"]) if (after[key] !== opened[key]) throw new Error("admin bootstrap CLI source changed during copy");
  if (!copied.isFile() || copied.nlink !== 1 || copied.size !== opened.size) throw new Error("materialized admin bootstrap CLI must be a complete single-link regular file");
} catch (error) { try { fs.unlinkSync(target); } catch {} throw error; }
finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
NODE
cp scripts/run-migrations.mjs "$stage_dir/scripts/run-migrations.mjs"
while IFS= read -r path; do
  allowed=0
  for allowed_path in "${allowed_release_script_paths[@]}"; do [[ "$path" == "$allowed_path" ]] && allowed=1; done
  (( allowed == 1 )) || { printf 'Release contains non-allowlisted script: %s\n' "$path" >&2; exit 1; }
done < <(find "$stage_dir/scripts" -type f -printf 'scripts/%P\n')
for path in "${forbidden_release_paths[@]}"; do
  [[ ! -e "$stage_dir/$path" && ! -L "$stage_dir/$path" ]] || { printf 'Release contains forbidden operational path: %s\n' "$path" >&2; exit 1; }
done
"${python_command[@]}" "$archive_tool_native" check-tree "$(native_path "$stage_dir")"
node --check "$stage_dir/scripts/admin-bootstrap.mjs"
node --check "$stage_dir/scripts/run-migrations.mjs"

RELEASE_STAGE_DIR="$stage_dir" \
RELEASE_ID="$release_id" \
COMMIT_SHA="$commit_sha" \
REPOSITORY_ID="$repository_id" \
REPOSITORY="$repository" \
SOURCE_RUN_ID="$source_run_id" \
SOURCE_RUN_ATTEMPT="$source_run_attempt" \
SOURCE_STATE="$source_state" \
SNAPSHOT_SHA256="$snapshot_sha256" \
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
  headCommitSha: process.env.COMMIT_SHA,
  sourceState: process.env.SOURCE_STATE,
  workingTreeDirty: process.env.SOURCE_STATE === "snapshot",
  snapshotSha256: process.env.SOURCE_STATE === "snapshot" ? process.env.SNAPSHOT_SHA256 : null,
  releaseId: process.env.RELEASE_ID,
  sourceRunId: Number(process.env.SOURCE_RUN_ID),
  sourceRunAttempt: Number(process.env.SOURCE_RUN_ATTEMPT),
  buildId: fs.readFileSync(path.join(stageDir, ".next", "BUILD_ID"), "utf8").trim(),
  archiveFile: `peilv-${process.env.RELEASE_ID}.tar.gz`,
  archiveSha256: null,
  createdAt: new Date(0).toISOString(),
  migrations: migrationManifest.migrations,
  files: [],
};
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(directory, entry.name);
  if (entry.isDirectory()) return walk(full);
  const relative = path.relative(stageDir, full).split(path.sep).join("/");
  if (relative === "release-manifest.json") return [];
  return [{ path: relative, sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") }];
});
manifest.files = walk(stageDir).sort((a,b)=>a.path.localeCompare(b.path));
fs.writeFileSync(path.join(stageDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
NODE

"${python_command[@]}" "$archive_tool_native" create "$(native_path "$stage_dir")" "$(native_path "$archive")"

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
