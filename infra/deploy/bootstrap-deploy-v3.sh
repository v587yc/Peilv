#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ "$(id -u)" == 0 ]] || { printf 'Root is required\n' >&2; exit 1; }
action=activate
if [[ "${1:-}" == recover-tcb-v3 ]]; then action=recover; shift; fi
[[ "$#" == 1 && -d "$1" && ! -L "$1" ]] || { printf 'Usage: bootstrap-deploy-v3.sh [recover-tcb-v3] <trusted-staging-directory>\n' >&2; exit 1; }
stage="$(readlink -f "$1")"
global_lock="${PEILV_GLOBAL_LOCK:-/run/lock/peilv-deploy.lock}"; tcb_lock="${PEILV_TCB_LOCK:-/run/lock/peilv-deploy-tcb.lock}"
exec 9>"$global_lock"; flock -n 9 || { printf 'Global deployment lock is busy; no target was changed\n' >&2; exit 75; }
exec 8>"$tcb_lock"; flock -n 8 || { printf 'TCB activation lock is busy; no target was changed\n' >&2; exit 75; }

sbin="${PEILV_TCB_SBIN:-/usr/local/sbin}"; libexec="${PEILV_TCB_LIBEXEC:-/usr/local/libexec/peilv}"
etc="${PEILV_TCB_ETC:-/etc/peilv}"; sudoers_dir="${PEILV_TCB_SUDOERS:-/etc/sudoers.d}"
state_root="${PEILV_TCB_STATE_ROOT:-/var/lib/peilv}"; operation_root="$state_root/deploy-operations"; result_root="$state_root/deploy-results"
journal="$state_root/tcb-v3-activation.json"; manifest_name=trusted-host-tcb-v3.sha256
manifest_sha='bb73c2d965c6fa8f3d62a57ed50597a493ce18da226e544f4a42790e5ae4d943'; sudoers_sha='1df904bda1d77c4abdd8b2c4bfe5375fb764a5c58a0e63ab1112f378d2e15833'
declare -a runtime_names=(deploy-production.sh production-preflight.sh rollback-production.sh migration-contract.mjs deploy-operation-ledger.mjs peilv-control)
declare -a activation_names=("${runtime_names[@]}" peilv-sudoers "$manifest_name")
declare -A destinations=(
 [deploy-production.sh]="$libexec/deploy-production.sh" [production-preflight.sh]="$libexec/production-preflight.sh"
 [rollback-production.sh]="$libexec/rollback-production.sh" [migration-contract.mjs]="$libexec/migration-contract.mjs"
 [deploy-operation-ledger.mjs]="$libexec/deploy-operation-ledger.mjs" [peilv-control]="$sbin/peilv-control"
 [peilv-sudoers]="$sudoers_dir/peilv" [$manifest_name]="$etc/$manifest_name")
declare -A modes=([deploy-production.sh]=755 [production-preflight.sh]=755 [rollback-production.sh]=755 [migration-contract.mjs]=755 [deploy-operation-ledger.mjs]=755 [peilv-control]=755 [peilv-sudoers]=440 [$manifest_name]=644)

sync_dir(){ sync -f "$1" 2>/dev/null || sync -d "$1"; }
hash_or_absent(){ [[ -f "$1" && ! -L "$1" && "$(stat -c %h "$1")" == 1 ]] && sha256sum "$1"|awk '{print $1}' || printf absent; }
safe_existing_dir(){ local p="$1" mode="$2"; [[ -d "$p" && ! -L "$p" && "$(stat -c '%U:%G:%a:%h' "$p")" == "root:root:$mode:1" ]]; }
existing_parent(){ local p="$1"; while [[ ! -e "$p" ]]; do p="$(dirname "$p")"; done; [[ -d "$p" && ! -L "$p" ]] || return 1; printf '%s\n' "$p"; }
write_journal(){
 local phase="$1" active="$2" sequence="$3"
 PHASE="$phase" ACTIVE="$active" SEQUENCE="$sequence" TX="$tx" JOURNAL="$journal" RECORDS="$(printf '%s\n' "${records[@]}")" CREATED="$(printf '%s\n' "${created_dirs[@]:-}")" node <<'NODE'
const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
const split=k=>(process.env[k]||"").split("\n").filter(Boolean);
const records=split("RECORDS").map(line=>{const [name,target,backup,oldHash,newHash,existed]=line.split("|");return{name,target,backup,oldHash,newHash,existed:existed==="1"}});
const body={schemaVersion:4,transactionId:process.env.TX,sequence:Number(process.env.SEQUENCE),phase:process.env.PHASE,activeObject:process.env.ACTIVE||null,records,createdDirectories:split("CREATED")};
body.digest=crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
const temp=`${process.env.JOURNAL}.next-${process.pid}`,fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
try{fs.writeFileSync(fd,JSON.stringify(body,null,2)+"\n");fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,process.env.JOURNAL);const d=fs.openSync(path.dirname(process.env.JOURNAL),"r");try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
NODE
}
validate_journal(){ JOURNAL="$journal" node <<'NODE'
const fs=require("node:fs"),crypto=require("node:crypto");const s=fs.lstatSync(process.env.JOURNAL);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>1048576||(process.platform!=="win32"&&((s.mode&511)!==384||s.uid!==0||s.gid!==0)))throw Error("unsafe journal");const j=JSON.parse(fs.readFileSync(process.env.JOURNAL,"utf8")),digest=j.digest;delete j.digest;if(j.schemaVersion!==4||!Number.isSafeInteger(j.sequence)||j.sequence<1||!Array.isArray(j.records)||!Array.isArray(j.createdDirectories)||digest!==crypto.createHash("sha256").update(JSON.stringify(j)).digest("hex"))throw Error("invalid journal digest");for(const r of j.records)if(!r.name||!r.target||!r.backup||!/^(absent|[0-9a-f]{64})$/.test(r.oldHash)||!/^[0-9a-f]{64}$/.test(r.newHash))throw Error("invalid journal record");
NODE
}
validate_journal_abi(){
 local expected_name expected_target expected_mode row name target backup old new existed index=0
 [[ "$tx" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ && ${#rows[@]} == ${#activation_names[@]} ]] || return 1
 for expected_name in "${activation_names[@]}"; do
  row="${rows[$index]}"; IFS='|' read -r name target backup old new existed <<<"$row"
  expected_target="${destinations[$expected_name]}"; expected_mode="${modes[$expected_name]}"
  [[ "$name" == "$expected_name" && "$target" == "$expected_target" && "$backup" == "$expected_target.tcb-v3-old-$tx" ]] || return 1
  [[ "$existed" == 0 || "$existed" == 1 ]] || return 1
  [[ "$old" == absent || "$old" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$new" =~ ^[0-9a-f]{64}$ ]] || return 1
  ((index+=1))
 done
}
recover_transaction(){
 validate_journal || { printf 'TCB journal is corrupt; manual assessment required\n' >&2; exit 78; }
 local recovery_sequence
 recovery_sequence="$(JOURNAL="$journal" node -e 'process.stdout.write(String(require(process.env.JOURNAL).sequence+1))')"
 tx="$(JOURNAL="$journal" node -e 'process.stdout.write(require(process.env.JOURNAL).transactionId)')"; records=(); created_dirs=()
 mapfile -t rows < <(JOURNAL="$journal" node -e 'const j=require(process.env.JOURNAL);for(const r of j.records)console.log([r.name,r.target,r.backup,r.oldHash,r.newHash,r.existed?1:0].join("|"))')
 mapfile -t created_dirs < <(JOURNAL="$journal" node -e 'for(const d of require(process.env.JOURNAL).createdDirectories)console.log(d)')
 for row in "${rows[@]}"; do IFS='|' read -r name target backup old new existed <<<"$row"; records+=("$name|$target|$backup|$old|$new|$existed"); done
 validate_journal_abi || { printf 'TCB journal ABI or path set is invalid\n' >&2; exit 78; }
 write_journal recovering '' "$recovery_sequence"
 local manifest_state=unknown row name target backup old new existed actual
 for row in "${rows[@]}"; do IFS='|' read -r name target backup old new existed <<<"$row"; [[ "$name" != "$manifest_name" ]] || { actual="$(hash_or_absent "$target")"; [[ "$actual" == "$new" ]] && manifest_state=new || { [[ "$actual" == "$old" || ( "$actual" == absent && "$(hash_or_absent "$backup")" == "$old" ) ]] && manifest_state=old; }; }; done
 if [[ "$manifest_state" == new ]]; then
   for row in "${rows[@]}"; do IFS='|' read -r name target backup old new existed <<<"$row"; [[ "$(hash_or_absent "$target")" == "$new" ]] || { printf 'Committed TCB generation is mixed; manual assessment required\n' >&2; exit 78; }; done
 else
   [[ "$manifest_state" == old ]] || { printf 'Manifest state cannot be proven; manual assessment required\n' >&2; exit 78; }
   for ((i=${#rows[@]}-1;i>=0;i--)); do IFS='|' read -r name target backup old new existed <<<"${rows[$i]}"; actual="$(hash_or_absent "$target")"; if [[ "$actual" == "$new" || ( "$actual" == absent && "$existed" == 1 ) ]]; then if [[ "$existed" == 1 ]]; then [[ "$(hash_or_absent "$backup")" == "$old" ]] || { printf 'Old generation backup cannot be proven\n' >&2; exit 78; }; mv -Tf "$backup" "$target"; else rm -f -- "$target"; fi; sync_dir "$(dirname "$target")"; elif [[ "$actual" != "$old" ]]; then printf 'TCB object state cannot be proven: %s\n' "$name" >&2; exit 78; fi; recovery_sequence=$((recovery_sequence+1)); write_journal recovering "$name" "$recovery_sequence"; [[ "${PEILV_TCB_RECOVERY_FAIL_AFTER:-}" != "$name" ]] || kill -KILL $$; done
  fi
  mapfile -t dirs < <(JOURNAL="$journal" node -e 'const j=require(process.env.JOURNAL);for(const d of [...j.createdDirectories].reverse())console.log(d)')
  for row in "${rows[@]}"; do IFS='|' read -r name target backup old new existed <<<"$row"; rm -f -- "$backup"; sync_dir "$(dirname "$backup")"; done
  rm -f -- "$journal"; sync_dir "$state_root"
  if [[ "$manifest_state" == old ]]; then for d in "${dirs[@]}"; do parent="$(dirname "$d")"; rmdir -- "$d" 2>/dev/null || true; sync_dir "$parent"; done; fi
 printf 'Host TCB v3 recovery completed: %s generation retained\n' "$manifest_state"
}

if [[ -e "$journal" ]]; then recover_transaction; [[ "$action" == recover ]] && exit 0; fi
[[ "$action" == activate ]] || { printf 'No durable TCB journal requires recovery\n' >&2; exit 1; }

# Validate every staged byte and ABI before touching existing host directory attributes.
for name in "${activation_names[@]}"; do source="$stage/$name"; [[ -f "$source" && ! -L "$source" && "$(stat -c '%U:%G:%h:%a' "$source")" == "root:root:1:${modes[$name]}" ]] || { printf 'Unsafe staged TCB object: %s\n' "$name" >&2; exit 1; }; LC_ALL=C grep -q $'\r' "$source" && { printf 'CRLF is forbidden: %s\n' "$name" >&2; exit 1; } || true; done
(cd "$stage"; sha256sum -c "$manifest_name" --strict)
[[ "$(sha256sum "$stage/$manifest_name"|awk '{print $1}')" == "$manifest_sha" && "$(sha256sum "$stage/peilv-sudoers"|awk '{print $1}')" == "$sudoers_sha" ]]
bash -n "$stage/peilv-control"; bash -n "$stage/deploy-production.sh"; bash -n "$stage/production-preflight.sh"; bash -n "$stage/rollback-production.sh"
node --check "$stage/migration-contract.mjs"; node --check "$stage/deploy-operation-ledger.mjs"; visudo -cf "$stage/peilv-sudoers"

# Reject cross-device activation before creating a trusted directory or mutating a target.
for name in "${activation_names[@]}"; do target="${destinations[$name]}"; parent="$(existing_parent "$(dirname "$target")")" || { printf 'Missing trusted destination ancestry: %s\n' "$target" >&2; exit 1; }; [[ "$(stat -c %d "$stage/$name")" == "$(stat -c %d "$parent")" ]] || { printf 'Cross-device activation forbidden before mutation\n' >&2; exit 1; }; done
declare -a created_dirs=(); declare -a required_dirs=("$state_root|700" "$operation_root|700" "$result_root|700" "$sbin|755" "$libexec|755" "$etc|755" "$sudoers_dir|755")
for item in "${required_dirs[@]}"; do IFS='|' read -r dir mode <<<"$item"; if [[ -e "$dir" ]]; then safe_existing_dir "$dir" "$mode" || { printf 'Unsafe existing directory: %s\n' "$dir" >&2; exit 1; }; else parent="$(dirname "$dir")"; [[ -d "$parent" && ! -L "$parent" ]] || { printf 'Missing trusted parent: %s\n' "$parent" >&2; exit 1; }; install -d -o root -g root -m "$mode" "$dir"; created_dirs+=("$dir"); sync_dir "$parent"; fi; done
for name in "${activation_names[@]}"; do target="${destinations[$name]}"; [[ ! -e "$target" ]] || [[ -f "$target" && ! -L "$target" && "$(stat -c '%U:%G:%a:%h' "$target")" == "root:root:${modes[$name]}:1" ]] || { printf 'Unsafe existing TCB object: %s\n' "$target" >&2; exit 1; }; done
sync_dir "$stage"

tx="$(date -u +%Y%m%dT%H%M%SZ)-$$"
records=(); for name in "${activation_names[@]}"; do target="${destinations[$name]}"; backup="$target.tcb-v3-old-$tx"; existed=0; [[ ! -e "$target" ]] || existed=1; [[ ! -e "$backup" ]] || { printf 'TCB backup path already exists\n' >&2; exit 1; }; [[ "$(stat -c %d "$(dirname "$target")")" == "$(stat -c %d "$(dirname "$backup")")" ]] || exit 1; records+=("$name|$target|$backup|$(hash_or_absent "$target")|$(hash_or_absent "$stage/$name")|$existed"); done
sequence=1; write_journal prepared '' "$sequence"
for row in "${records[@]}"; do IFS='|' read -r name target backup old new existed <<<"$row"; temp="$target.next-v3-$tx"; install -o root -g root -m "${modes[$name]}" "$stage/$name" "$temp"; sync -f "$temp"; sync_dir "$(dirname "$temp")"; [[ ! -e "$target" ]] || { mv -T "$target" "$backup"; sync_dir "$(dirname "$backup")"; }; [[ "${PEILV_TCB_FAIL_AFTER:-}" != "$name:backup" ]] || kill -KILL $$; mv -T "$temp" "$target"; sync_dir "$(dirname "$target")"; sequence=$((sequence+1)); write_journal activating "$name" "$sequence"; [[ "${PEILV_TCB_FAIL_AFTER:-}" != "$name" ]] || kill -KILL $$; done
for row in "${records[@]}"; do IFS='|' read -r name target backup old new existed <<<"$row"; [[ "$(hash_or_absent "$target")" == "$new" ]] || { printf 'Activated TCB verification failed\n' >&2; exit 78; }; done
for row in "${records[@]}"; do IFS='|' read -r name target backup old new existed <<<"$row"; rm -f -- "$backup"; sync_dir "$(dirname "$backup")"; done
rm -f -- "$journal"; sync_dir "$state_root"
printf 'Deploy Host TCB v3 activated with six-runtime exact set\n'
