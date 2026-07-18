#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"; source_helper="$repo_root/scripts/lib/candidate-stage.sh"; work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/source/sub" "$work/stage-root" "$work/bin"; printf server >"$work/source/server.js"; printf asset >"$work/source/sub/asset.txt"
TEST_SOURCE="$source_helper" TEST_TARGET="$work/helper.sh" TEST_ROOT_B64="$(printf %s "$work/stage-root" | base64 | tr -d '\r\n')" node <<'NODE'
const fs=require('node:fs');const root=Buffer.from(process.env.TEST_ROOT_B64,'base64').toString();let s=fs.readFileSync(process.env.TEST_SOURCE,'utf8');s=s.replaceAll('/var/lib/peilv/candidate-stage',root);fs.writeFileSync(process.env.TEST_TARGET,s)
NODE
cat >"$work/bin/stat" <<'SH'
#!/bin/bash
case " $* " in *" -f -c %T "*) printf '%s\n' "${FAKE_FS_TYPE:-ext2/ext3}";; *" -c %U:%G:%a:%h "*) printf '%s\n' "${FAKE_ROOT_META:-root:root:700:2}";; *" -c %U:%G "*) printf 'root:root\n';; *) exec /usr/bin/stat "$@";; esac
SH
cat >"$work/bin/df" <<'SH'
#!/bin/bash
case " $* " in
  *" -Pk "*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nmock 999999 1 %s 1%% /mock\n' "${FAKE_AVAILABLE_KIB:-999999}" ;;
  *" -Pi "*) printf 'Filesystem Inodes IUsed IFree IUse%% Mounted\nmock 999999 1 %s 1%% /mock\n' "${FAKE_AVAILABLE_INODES:-999999}" ;;
  *) exit 2 ;;
esac
SH
cat >"$work/bin/quota" <<'SH'
#!/bin/bash
exit 0
SH
cat >"$work/bin/du" <<'SH'
#!/bin/bash
printf '1\t%s\n' "${@: -1}"
SH
chmod +x "$work/bin/"*
run_case(){ env PATH="$work/bin:$PATH" PEILV_CANDIDATE_STAGE_ROOT="$work/stage-root" PEILV_CANDIDATE_MIN_MARGIN_KIB=1 PEILV_CANDIDATE_MIN_MARGIN_INODES=1 FAKE_FS_TYPE="${FAKE_FS_TYPE:-ext2/ext3}" FAKE_ROOT_META="${FAKE_ROOT_META:-root:root:700:2}" FAKE_AVAILABLE_KIB="${FAKE_AVAILABLE_KIB:-999999}" FAKE_AVAILABLE_INODES="${FAKE_AVAILABLE_INODES:-999999}" bash -c 'source "$1"; candidate_check_capacity "$2"' bash "$work/helper.sh" "$work/source" >"$work/run.log" 2>&1; }
reject(){ local label="$1"; shift; "$@" && { printf '%s was accepted\n' "$label" >&2; exit 1; }; printf 'PASS %s\n' "$label"; }
FAKE_FS_TYPE=tmpfs reject tmpfs run_case
unset FAKE_FS_TYPE; FAKE_ROOT_META=root:root:755:2 reject bad_parent_mode run_case
unset FAKE_ROOT_META; FAKE_AVAILABLE_KIB=1 reject insufficient_space run_case
unset FAKE_AVAILABLE_KIB; FAKE_AVAILABLE_INODES=1 reject insufficient_inodes run_case
unset FAKE_AVAILABLE_INODES; run_case || { cat "$work/run.log" >&2; exit 1; }
mkdir "$work/root-link-target"; ln -s "$work/root-link-target" "$work/root-link"
TEST_SOURCE="$source_helper" TEST_TARGET="$work/link-helper.sh" TEST_ROOT_B64="$(printf %s "$work/root-link" | base64 | tr -d '\r\n')" node <<'NODE'
const fs=require('node:fs');const root=Buffer.from(process.env.TEST_ROOT_B64,'base64').toString();let s=fs.readFileSync(process.env.TEST_SOURCE,'utf8');s=s.replaceAll('/var/lib/peilv/candidate-stage',root);fs.writeFileSync(process.env.TEST_TARGET,s)
NODE
env PEILV_CANDIDATE_STAGE_ROOT="$work/root-link" bash -c 'source "$1"; candidate_assert_stage_root' bash "$work/link-helper.sh" >/dev/null 2>&1 && { printf 'symlink parent was accepted\n' >&2; exit 1; }
env PEILV_CANDIDATE_STAGE_ROOT="$work/stage-root" bash -c 'source "$1"; candidate_stage_path r1-a1-aaaaaaaaaaaa >/dev/null; ! candidate_stage_path ../../shared >/dev/null 2>&1' bash "$work/helper.sh"
printf 'candidate staging dynamic checks passed\n'
