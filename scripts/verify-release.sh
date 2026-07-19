#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage='Usage: verify-release.sh <archive> <checksum> | --archive <archive> <expected-sha256> <extract-dir> <expected-archive-name> | --tree <release-dir> [--root-owned]'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
archive_tool="$script_dir/release-archive.py"
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }
run_python() { if python3 -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null 2>&1; then python3 "$@"; elif py -3 -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null 2>&1; then py -3 "$@"; else printf 'Python 3.9+ is required for release verification\n' >&2; return 1; fi; }
mode="${1:-}"
temporary_extract=""
cleanup() { [[ -z "$temporary_extract" ]] || rm -rf -- "$temporary_extract"; }
trap cleanup EXIT HUP INT TERM

required_files=(
  .next/BUILD_ID .next/routes-manifest.json server.js package.json scripts/admin-bootstrap.mjs scripts/run-migrations.mjs
  infra/local-data/compose.yml infra/local-data/nginx/default.conf infra/openresty/peilv.conf
  infra/openresty/peilv-1panel-http.conf infra/openresty/peilv-1panel-root.conf
  infra/systemd/peilv.service infra/systemd/peilv-reconcile.service infra/systemd/peilv-reconcile.timer
  infra/systemd/peilv-dispatch.service infra/systemd/peilv-dispatch.timer
  migrations/manifest.json release-manifest.json
)
required_dirs=(.next/static public)
allowed_release_script_paths=(scripts/admin-bootstrap.mjs scripts/run-migrations.mjs)
forbidden_release_paths=(
  scripts/start.sh scripts/reconcile-automation.sh scripts/dispatch-automation.sh scripts/rotate-internal-secret.sh
  scripts/deploy-production.sh scripts/production-preflight.sh scripts/rollback-production.sh
  scripts/create-release.sh scripts/verify-release.sh scripts/release-materialize.mjs scripts/release-archive.py
  scripts/private-copy.mjs scripts/lib
)

verify_app_unit_contract() {
  local unit="$1" key expected
  [[ -f "$unit" && ! -L "$unit" ]] || { printf 'Application systemd unit is missing or unsafe\n' >&2; return 1; }
  for expected in 'HOSTNAME=127.0.0.1' 'PORT=5000' 'DEPLOY_RUN_PORT=5000'; do
    key="${expected%%=*}"
    [[ "$(grep -Ec "^Environment=${key}=" "$unit")" == 1 ]] || { printf 'Application systemd unit must define Environment=%s exactly once\n' "$key" >&2; return 1; }
    grep -Fxq "Environment=$expected" "$unit" || { printf 'Application systemd unit has an invalid %s contract\n' "$key" >&2; return 1; }
  done
  ! grep -Eq 'Environment=(HOSTNAME=0\.0\.0\.0|PORT=3000|DEPLOY_RUN_PORT=3000)$' "$unit" || { printf 'Application systemd unit contains a forbidden legacy listener\n' >&2; return 1; }
  grep -Fxq 'ExecStart=/usr/bin/node /opt/peilv/current/server.js' "$unit" || { printf 'Application systemd unit has an invalid start command\n' >&2; return 1; }
}

verify_tree() {
  local root="$1" require_root_owner="${2:-0}" path
  [[ -d "$root" && ! -L "$root" ]] || { printf 'Release tree is missing or is a symlink\n' >&2; return 1; }
  run_python "$(native_path "$archive_tool")" check-tree "$(native_path "$root")" || return 1
  for path in "${required_files[@]}"; do
    [[ -f "$root/$path" && ! -L "$root/$path" ]] || { printf 'Release tree is missing required file: %s\n' "$path" >&2; return 1; }
  done
  for path in "${required_dirs[@]}"; do
    [[ -d "$root/$path" && ! -L "$root/$path" && -n "$(find "$root/$path" -type f -print -quit)" ]] || {
      printf 'Release tree is missing required non-empty directory: %s\n' "$path" >&2; return 1;
    }
  done
  verify_app_unit_contract "$root/infra/systemd/peilv.service" || return 1
  for path in "${forbidden_release_paths[@]}"; do
    [[ ! -e "$root/$path" && ! -L "$root/$path" ]] || { printf 'Release tree contains forbidden operational path: %s\n' "$path" >&2; return 1; }
  done
  while IFS= read -r path; do
    local allowed=0 allowed_path
    for allowed_path in "${allowed_release_script_paths[@]}"; do [[ "$path" == "$allowed_path" ]] && allowed=1; done
    (( allowed == 1 )) || { printf 'Release tree contains non-allowlisted script: %s\n' "$path" >&2; return 1; }
  done < <(find "$root/scripts" -type f -printf 'scripts/%P\n')
  if find "$root" -type l -o \( ! -type f ! -type d \) | grep -q .; then
    printf 'Release tree contains a link or special file\n' >&2; return 1
  fi
  if (( require_root_owner == 1 )); then
    if find "$root" \( ! -user root -o -perm /0022 \) -print -quit | grep -q .; then
      printf 'Installed release tree is not immutable and root-owned\n' >&2; return 1
    fi
  fi
  EXTRACT_DIR="$root" node <<'NODE'
const crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const root=process.env.EXTRACT_DIR, fail=m=>{throw new Error(m)}, sha=/^[0-9a-f]{64}$/;
const release=JSON.parse(fs.readFileSync(path.join(root,"release-manifest.json"),"utf8"));
const migrations=JSON.parse(fs.readFileSync(path.join(root,"migrations/manifest.json"),"utf8"));
const packageJson=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
if(packageJson?.scripts?.["admin:bootstrap"]!=="node ./scripts/admin-bootstrap.mjs")fail("Invalid admin bootstrap package command");
if(release.schemaVersion!==1||migrations.schemaVersion!==1)fail("Unsupported manifest schema");
if(!Number.isSafeInteger(release.repositoryId)||release.repositoryId<=0||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(release.repository))fail("Invalid repository provenance");
if(!/^[0-9a-f]{40}$/.test(release.commitSha)||!/^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/.test(release.releaseId))fail("Invalid release provenance");
if(release.releaseId!==`r${release.sourceRunId}-a${release.sourceRunAttempt}-${release.commitSha.slice(0,12)}`)fail("Release provenance mismatch");
if(release.archiveFile!==`peilv-${release.releaseId}.tar.gz`||release.archiveSha256!==null)fail("Invalid embedded archive binding");
if(!Array.isArray(release.files)||release.files.length===0||!Array.isArray(release.migrations)||JSON.stringify(release.migrations)!==JSON.stringify(migrations.migrations))fail("Invalid manifests");
const actual=[];
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).forEach(e=>{const full=path.join(dir,e.name);if(e.isDirectory())return walk(full);if(!e.isFile())fail(`Non-regular tree entry: ${full}`);const rel=path.relative(root,full).split(path.sep).join("/");if(rel!=="release-manifest.json")actual.push({path:rel,sha256:crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")});});
walk(root);actual.sort((a,b)=>a.path.localeCompare(b.path));
const declared=[...release.files].sort((a,b)=>String(a.path).localeCompare(String(b.path)));
if(declared.some((x,i)=>!x||typeof x.path!=="string"||!sha.test(x.sha256)||(i&&declared[i-1].path===x.path)))fail("Invalid or duplicate release file hash");
if(JSON.stringify(actual)!==JSON.stringify(declared))fail("Release file tree hash mismatch");
for(const required of ["package.json","scripts/admin-bootstrap.mjs","scripts/run-migrations.mjs"]){const entry=declared.find(x=>x.path===required);if(!entry)fail(`Required release manifest entry missing: ${required}`);const target=path.join(root,required),info=fs.lstatSync(target);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)fail(`Required release target is not a single-link regular file: ${required}`);if(crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")!==entry.sha256)fail(`Required release manifest hash mismatch: ${required}`)}
const sql=fs.readdirSync(path.join(root,"migrations"),{withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith(".sql")).map(e=>e.name).sort();
const declaredSql=migrations.migrations.map(x=>x.file).sort();if(JSON.stringify(sql)!==JSON.stringify(declaredSql)||sql.length===0)fail("Migration file set mismatch");
const files=new Set(),versions=new Set();for(const m of migrations.migrations){if(!/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(m.file)||!/^[0-9]{4}_[a-z0-9_]+$/.test(m.version)||m.file!==`${m.version}.sql`||!sha.test(m.sha256)||typeof m.codeRollbackSafe!=="boolean"||files.has(m.file)||versions.has(m.version))fail("Invalid migration metadata");files.add(m.file);versions.add(m.version);const content=fs.readFileSync(path.join(root,"migrations",m.file));if(crypto.createHash("sha256").update(content).digest("hex")!==m.sha256)fail(`Migration binding mismatch: ${m.file}`)}
NODE
  node --check "$root/scripts/admin-bootstrap.mjs" || { printf 'Admin bootstrap CLI syntax check failed\n' >&2; return 1; }
  node --check "$root/scripts/run-migrations.mjs" || { printf 'Migration runner syntax check failed\n' >&2; return 1; }
  if grep -RIlE --exclude='*.map' -- '(-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,})' "$root" | grep -q .; then
    printf 'Release tree contains a credential signature\n' >&2; return 1
  fi
  if [[ -n "${KNOWN_SECRET_FILE:-}" && -s "$KNOWN_SECRET_FILE" ]] && grep -RIlF -f "$KNOWN_SECRET_FILE" "$root" | grep -q .; then
    printf 'Release tree contains a known secret value\n' >&2; return 1
  fi
}

verify_archive() {
  local archive="$1" expected_sha="$2" extract_dir="$3" expected_name="$4" actual_sha
  [[ -f "$archive" && ! -L "$archive" && "$expected_sha" =~ ^[0-9a-f]{64}$ && "$expected_name" =~ ^peilv-r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}\.tar\.gz$ ]] || { printf 'Invalid archive verification input\n' >&2; return 1; }
  [[ -d "$extract_dir" && ! -L "$extract_dir" && -z "$(find "$extract_dir" -mindepth 1 -print -quit)" ]] || { printf 'Extraction directory must be empty\n' >&2; return 1; }
  actual_sha="$(run_python "$(native_path "$archive_tool")" verify-extract "$(native_path "$archive")" "$(native_path "$extract_dir")" "$expected_sha")" || return 1
  verify_tree "$extract_dir"
  [[ "$(node -e 'const fs=require("node:fs"),path=require("node:path");process.stdout.write(JSON.parse(fs.readFileSync(path.resolve(process.argv[1]),"utf8")).archiveFile)' "$extract_dir/release-manifest.json")" == "$expected_name" ]] || { printf 'Archive filename binding mismatch\n' >&2; return 1; }
  printf '%s\n' "$actual_sha"
}

if [[ "$mode" == --tree ]]; then
  if (( $# != 2 )) && { (( $# != 3 )) || [[ "$3" != --root-owned ]]; }; then printf '%s\n' "$usage" >&2; exit 2; fi
  verify_tree "$2" "$([[ "${3:-}" == --root-owned ]] && printf 1 || printf 0)"
  printf 'Verified release tree: %s\n' "$2"
elif [[ "$mode" == --archive ]]; then
  [[ $# -eq 5 ]] || { printf '%s\n' "$usage" >&2; exit 2; }
  verify_archive "$2" "$3" "$4" "$5"
else
  [[ $# -eq 2 ]] || { printf '%s\n' "$usage" >&2; exit 2; }
  archive="$1"; checksum="$2"; [[ -f "$checksum" && ! -L "$checksum" ]] || { printf 'Checksum file does not exist\n' >&2; exit 1; }
  line="$(sed -n '1p' "$checksum")"; sha="${line%% *}"; name="${line#"$sha"}"; name="${name# }"; name="${name# }"; name="${name#\*}"
  [[ "$name" == "$(basename "$archive")" ]] || { printf 'Checksum file does not match archive\n' >&2; exit 1; }
  temporary_extract="$(mktemp -d "${TMPDIR:-/tmp}/peilv-verify.XXXXXX")"
  verify_archive "$archive" "$sha" "$temporary_extract" "$name" >/dev/null
  printf 'Verified release artifact: %s\n' "$name"
fi
