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

while IFS= read -r migration; do
  name="$(basename "$migration")"
  version="${name%.sql}"
  if [[ ! "$name" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] || ! grep -Fq "'$version'" "$migration"; then
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
