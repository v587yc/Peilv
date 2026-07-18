#!/bin/bash
set -Eeuo pipefail
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
mkdir -p "$work/project/scripts" "$work/bin"
cp "$source_root/scripts/create-release.sh" "$work/project/scripts/create-release.sh"
cat >"$work/bin/tar" <<'FAKE'
#!/bin/sh
printf called >"$TOOL_CALLED"; exit 97
FAKE
chmod +x "$work/bin/tar"
# A required directory represented as a regular file must be rejected before tar/staging.
mkdir -p "$work/project/.next/standalone/.next"
printf x >"$work/project/.next/standalone/.next/static"
marker="$work/tool-called"
if PATH="$work/bin:$PATH" TOOL_CALLED="$marker" bash "$work/project/scripts/create-release.sh" \
  r1-a1-aaaaaaaaaaaa "$(printf 'a%.0s' {1..40})" 1 owner/repo 1 1 >/dev/null 2>&1; then
  printf 'FAIL accepted_directory_as_file\n' >&2; exit 1
fi
[[ ! -e "$marker" ]] || { printf 'FAIL staged_before_directory_validation\n' >&2; exit 1; }
printf 'PASS rejected_directory_as_file\n'
