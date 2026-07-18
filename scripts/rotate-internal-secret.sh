#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${1:-}" == --dry-run && $# == 1 ]] || {
  printf 'This high-risk operation only supports --dry-run. Obtain explicit production approval before implementing execution.\n' >&2
  exit 2
}
base=/opt/peilv
credential="$base/shared/credentials/internal-api-secret"
parent="$(dirname "$credential")"
[[ -d "$parent" && ! -L "$parent" ]]
[[ "$(stat -c '%U:%G:%a' "$parent")" == root:root:700 ]]
[[ -f "$credential" && ! -L "$credential" && "$(stat -c '%U:%G:%a' "$credential")" == root:root:600 ]]
for unit in peilv.service peilv-reconcile.service peilv-dispatch.service; do systemctl cat "$unit" >/dev/null; done
cat <<'PLAN'
DRY-RUN ONLY — no credential was read or changed.
Approved execution must: create a root-owned 0600 temp file in the credential directory; write the approved 32–128 base64url value; fsync the file and parent directory; atomically rename over internal-api-secret; restart peilv.service, peilv-reconcile.service and peilv-dispatch.service; run authenticated health checks through systemd LoadCredential; verify the previous credential is rejected; then run production-preflight.
PLAN
