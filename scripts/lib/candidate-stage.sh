#!/usr/bin/env bash

CANDIDATE_STAGE_ROOT="${PEILV_CANDIDATE_STAGE_ROOT:-/var/lib/peilv/candidate-stage}"
CANDIDATE_RELEASE_PATTERN='^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$'
CANDIDATE_MIN_MARGIN_KIB="${PEILV_CANDIDATE_MIN_MARGIN_KIB:-262144}"
CANDIDATE_MIN_MARGIN_INODES="${PEILV_CANDIDATE_MIN_MARGIN_INODES:-1024}"
CANDIDATE_LOCK_FILE="${PEILV_CANDIDATE_LOCK_FILE:-${CANDIDATE_STAGE_ROOT}.lock}"

candidate_stage_path() {
  local release_id="$1"
  [[ "$release_id" =~ $CANDIDATE_RELEASE_PATTERN ]] || { printf 'Invalid candidate release ID\n' >&2; return 1; }
  printf '%s/%s' "$CANDIDATE_STAGE_ROOT" "$release_id"
}

candidate_assert_stage_root() {
  local owner_mode fs_type
  [[ "$CANDIDATE_STAGE_ROOT" == /var/lib/peilv/candidate-stage ]] || return 1
  [[ -d "$CANDIDATE_STAGE_ROOT" && ! -L "$CANDIDATE_STAGE_ROOT" ]] || return 1
  owner_mode="$(stat -c '%U:%G:%a:%h' -- "$CANDIDATE_STAGE_ROOT")" || return 1
  IFS=: read -r owner group mode links <<<"$owner_mode"
  [[ "$owner:$group:$mode" == root:root:700 && "$links" =~ ^[0-9]+$ && "$links" -ge 2 ]] || { printf 'Candidate staging parent must be root:root 0700 with a valid directory link count\n' >&2; return 1; }
  fs_type="$(stat -f -c '%T' -- "$CANDIDATE_STAGE_ROOT")" || return 1
  case "$fs_type" in tmpfs|ramfs) printf 'Candidate staging filesystem must be disk-backed, not %s\n' "$fs_type" >&2; return 1 ;; esac
}

candidate_ensure_stage_root() {
  local parent=/var/lib/peilv
  [[ -d "$parent" && ! -L "$parent" && "$(stat -c '%U:%G' -- "$parent")" == root:root ]]
  install -d -o root -g root -m 0700 -- "$CANDIDATE_STAGE_ROOT"
  candidate_assert_stage_root
}

candidate_tree_size_kib() {
  local tree="$1"
  [[ -d "$tree" && ! -L "$tree" ]]
  du -sk -- "$tree" | awk 'NR == 1 {print $1}'
}

candidate_check_capacity() {
  local source="$1" size_kib source_inodes available_kib available_inodes margin_kib required_kib required_inodes
  candidate_assert_stage_root || return 1
  size_kib="$(candidate_tree_size_kib "$source")" || return 1
  [[ "$size_kib" =~ ^[1-9][0-9]*$ ]] || return 1
  margin_kib=$((size_kib / 4))
  (( margin_kib >= CANDIDATE_MIN_MARGIN_KIB )) || margin_kib="$CANDIDATE_MIN_MARGIN_KIB"
  required_kib=$((size_kib + margin_kib))
  available_kib="$(df -Pk -- "$CANDIDATE_STAGE_ROOT" | awk 'NR == 2 {print $4}')"
  source_inodes="$(find -P "$source" -xdev -printf . | wc -c)"
  required_inodes=$((source_inodes + CANDIDATE_MIN_MARGIN_INODES))
  available_inodes="$(df -Pi -- "$CANDIDATE_STAGE_ROOT" | awk 'NR == 2 {print $4}')"
  [[ "$available_kib" =~ ^[0-9]+$ && "$available_inodes" =~ ^[0-9]+$ ]] || return 1
  if (( available_kib < required_kib )); then
    printf 'Candidate staging requires %s KiB but only %s KiB is available\n' "$required_kib" "$available_kib" >&2
    return 1
  fi
  if (( available_inodes < required_inodes )); then
    printf 'Candidate staging requires %s inodes but only %s are available\n' "$required_inodes" "$available_inodes" >&2
    return 1
  fi
  if command -v quota >/dev/null 2>&1; then
    quota -w -u root >/dev/null || { printf 'Candidate staging quota check failed\n' >&2; return 1; }
  fi
  printf '%s %s %s %s %s\n' "$size_kib" "$margin_kib" "$available_kib" "$required_inodes" "$available_inodes"
}

candidate_tree_hash() {
  local tree="$1"
  [[ -d "$tree" && ! -L "$tree" ]]
  /usr/bin/node - "$tree" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(process.argv[2]);
const entries = [];
function walk(directory, relative = "") {
  for (const name of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    const rel = relative ? `${relative}/${name}` : name;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsafe candidate tree entry: ${rel}`);
    if (stat.isDirectory()) { entries.push(["d", rel, ""]); walk(full, rel); }
    else entries.push(["f", rel, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
  }
}
walk(root);
const digest = crypto.createHash("sha256");
for (const entry of entries) digest.update(entry[0]).update("\0").update(entry[1]).update("\0").update(entry[2]).update("\0");
process.stdout.write(`${digest.digest("hex")}\n`);
NODE
}

candidate_cleanup_stage() {
  local release_id="$1" stage
  stage="$(candidate_stage_path "$release_id")"
  candidate_assert_stage_root
  [[ ! -L "$stage" ]] || { printf 'Refusing to clean a symlink candidate stage\n' >&2; return 1; }
  [[ ! -e "$stage" || -d "$stage" ]] || { printf 'Candidate stage is not a directory\n' >&2; return 1; }
  [[ ! -e "$stage" ]] || rm -rf --one-file-system -- "$stage"
  [[ ! -e "$stage" && ! -L "$stage" ]]
}

candidate_prepare_stage() {
  local source="$1" release_id="$2" verifier="$3" stage source_hash stage_hash lock_parent lock_fd
  [[ -d "$source" && ! -L "$source" && -x "$verifier" ]]
  stage="$(candidate_stage_path "$release_id")"
  lock_parent="$(dirname "$CANDIDATE_LOCK_FILE")"
  [[ -d "$lock_parent" && ! -L "$lock_parent" ]]
  exec {lock_fd}>"$CANDIDATE_LOCK_FILE"
  flock -n "$lock_fd" || { printf 'Another candidate staging operation is running\n' >&2; return 1; }
  candidate_ensure_stage_root
  [[ ! -e "$stage" && ! -L "$stage" ]] || { printf 'Candidate stage already exists; lifecycle cleanup is required\n' >&2; return 1; }
  candidate_check_capacity "$source" >/dev/null
  source_hash="$(candidate_tree_hash "$source")"
  install -d -o root -g root -m 0700 -- "$stage"
  cp -a -- "$source/." "$stage/"
  [[ ! -L "$stage" && "$(stat -c '%U:%G' -- "$stage")" == root:root ]]
  stage_hash="$(candidate_tree_hash "$stage")"
  [[ "$stage_hash" == "$source_hash" ]] || { printf 'Candidate staging tree hash mismatch\n' >&2; return 1; }
  "$verifier" --tree "$stage" >/dev/null
  chown -R root:peilv-candidate -- "$stage"
  find -P "$stage" -type d -exec chmod 0550 -- {} +
  find -P "$stage" -type f -exec chmod 0440 -- {} +
  [[ "$(candidate_tree_hash "$stage")" == "$source_hash" ]]
  printf '%s\n' "$stage"
}
