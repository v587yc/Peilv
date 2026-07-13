#!/usr/bin/env bash
set -Eeuo pipefail

archive="${1:?Usage: verify-release.sh <archive> <checksum>}"
checksum="${2:?Usage: verify-release.sh <archive> <checksum>}"

archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"
checksum="$(cd "$(dirname "$checksum")" && pwd)/$(basename "$checksum")"

if [[ ! -f "$archive" || ! -f "$checksum" ]]; then
  printf 'Archive or checksum file does not exist\n' >&2
  exit 1
fi

expected_line="$(sed -n '1p' "$checksum")"
expected_sha="${expected_line%% *}"
expected_name="${expected_line#"$expected_sha"}"
expected_name="${expected_name# }"
expected_name="${expected_name# }"
expected_name="${expected_name#\*}"
if [[ ! "$expected_sha" =~ ^[0-9a-f]{64}$ || "$expected_name" != "$(basename "$archive")" ]]; then
  printf 'Checksum file does not match the supplied archive\n' >&2
  exit 1
fi
actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
if [[ "$actual_sha" != "$expected_sha" ]]; then
  printf 'Archive checksum mismatch\n' >&2
  exit 1
fi

list_file="$(mktemp)"
extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/peilv-verify.XXXXXX")"
trap 'rm -f "$list_file"; rm -rf "$extract_dir"' EXIT

tar -tzf "$archive" > "$list_file"

normalize_members() {
  sed -e 's#^\./##' -e '/^$/d' "$list_file"
}

if normalize_members | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  printf 'Archive contains an unsafe path\n' >&2
  exit 1
fi

if normalize_members | grep -Eiq '(^|/)(\.env($|\.)|node_modules($|/)|\.local-data($|/)|coverage($|/)|test-results($|/)|playwright-report($|/)|blob-report($|/)|[^/]*\.(log|dump|backup|pem|key|p12|pfx)$|\.next/(cache|dev|diagnostics)($|/))'; then
  printf 'Archive contains a forbidden member\n' >&2
  exit 1
fi

if tar -tvzf "$archive" | awk 'substr($1,1,1) !~ /^[-d]$/ { found=1 } END { exit found ? 0 : 1 }'; then
  printf 'Archive contains a link or special file\n' >&2
  exit 1
fi

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
  release-manifest.json
)

members="$(normalize_members)"
for path in "${required[@]}"; do
  if ! grep -Fxq "$path" <<<"$members"; then
    printf 'Archive is missing required member: %s\n' "$path" >&2
    exit 1
  fi
done

if ! grep -Eq '^migrations/[^/]+\.sql$' <<<"$members"; then
  printf 'Archive contains no migration files\n' >&2
  exit 1
fi

tar -xzf "$archive" -C "$extract_dir" --no-same-owner --no-same-permissions

ARCHIVE_PATH="$archive" EXPECTED_SHA="$expected_sha" EXTRACT_DIR="$extract_dir" node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.EXTRACT_DIR;
const release = JSON.parse(fs.readFileSync(path.join(root, "release-manifest.json"), "utf8"));
const migrations = JSON.parse(fs.readFileSync(path.join(root, "migrations", "manifest.json"), "utf8"));
const fail = message => { throw new Error(message); };
const releasePattern = /^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
if (release.schemaVersion !== 1 || migrations.schemaVersion !== 1) fail("Unsupported manifest schema");
if (!Number.isSafeInteger(release.repositoryId) || release.repositoryId <= 0) fail("Invalid repository ID");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(release.repository)) fail("Invalid repository");
if (!commitPattern.test(release.commitSha) || !releasePattern.test(release.releaseId)) fail("Invalid release provenance");
if (release.releaseId !== `r${release.sourceRunId}-a${release.sourceRunAttempt}-${release.commitSha.slice(0, 12)}`) fail("Release provenance mismatch");
if (release.archiveFile !== path.basename(process.env.ARCHIVE_PATH)) fail("Archive filename mismatch");
if (release.archiveSha256 !== null) fail("Embedded archive checksum must be null");
if (!Array.isArray(release.migrations) || !Array.isArray(migrations.migrations)) fail("Invalid migrations manifest");
if (JSON.stringify(release.migrations) !== JSON.stringify(migrations.migrations)) fail("Migration manifests differ");
const sqlFiles = fs.readdirSync(path.join(root, "migrations")).filter(name => name.endsWith(".sql")).sort();
const declaredFiles = migrations.migrations.map(value => value.file).sort();
if (JSON.stringify(sqlFiles) !== JSON.stringify(declaredFiles)) fail("Migration file set mismatch");
const files = new Set();
const versions = new Set();
for (const migration of migrations.migrations) {
  if (!/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(migration.file)) fail("Invalid migration filename");
  if (!/^[0-9]{4}_[a-z0-9_]+$/.test(migration.version)) fail("Invalid migration version");
  if (!shaPattern.test(migration.sha256) || typeof migration.codeRollbackSafe !== "boolean") fail("Invalid migration metadata");
  if (files.has(migration.file) || versions.has(migration.version)) fail("Duplicate migration metadata");
  files.add(migration.file);
  versions.add(migration.version);
  const content = fs.readFileSync(path.join(root, "migrations", migration.file));
  const actual = crypto.createHash("sha256").update(content).digest("hex");
  if (actual !== migration.sha256) fail(`Migration checksum mismatch: ${migration.file}`);
  const text = content.toString("utf8");
  if (!text.includes(`'${migration.version}'`)) fail(`Migration registration mismatch: ${migration.file}`);
}
if (!shaPattern.test(process.env.EXPECTED_SHA)) fail("Invalid expected archive checksum");
NODE

while IFS= read -r migration; do
  name="$(basename "$migration")"
  version="$(sed -n '/INSERT INTO schema_migrations(version, description)/,/ON CONFLICT/p' "$migration" | sed -nE "0,/^[[:space:]]*'([^']+)'[[:space:]]*,?[[:space:]]*$/s//\\1/p" | head -n 1)"
  if [[ ! "$name" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ || -z "$version" ]]; then
    printf 'Migration filename or registered version is invalid: %s\n' "$name" >&2
    exit 1
  fi
done < <(find "$extract_dir/migrations" -maxdepth 1 -type f -name '*.sql' -print)

if grep -RIlE --exclude='*.map' -- '(-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,})' "$extract_dir" | grep -q .; then
  printf 'Archive contains a credential signature\n' >&2
  exit 1
fi

if [[ -n "${KNOWN_SECRET_FILE:-}" && -s "$KNOWN_SECRET_FILE" ]]; then
  if grep -RIlF -f "$KNOWN_SECRET_FILE" "$extract_dir" | grep -q .; then
    printf 'Archive contains a known secret value\n' >&2
    exit 1
  fi
fi

printf 'Verified release artifact: %s\n' "$(basename "$archive")"
