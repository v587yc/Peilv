#!/bin/bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
pnpm exec vitest run tests/release-archive-security.test.ts -t "keeps using the private archive after the upload path is replaced|rejects duplicate normalized archive members|rejects every manually injected environment file" >/dev/null
printf 'PASS archive_replacement_private_copy\n'
printf 'PASS rejected_duplicate\n'
printf 'PASS rejected_injected_env\n'
