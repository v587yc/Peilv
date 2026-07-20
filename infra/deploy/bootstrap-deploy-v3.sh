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
state_root="${PEILV_TCB_STATE_ROOT:-/var/lib/peilv}"; operation_root="$state_root/deploy-operations"; result_root="$state_root/deploy-results"; evidence_root="$state_root/tcb-forensics"
journal="$state_root/tcb-v3-activation.json"; manifest_name=trusted-host-tcb-v3.sha256; legacy_policy_name=legacy-sudoers-retirement-v1.sha256
manifest_sha='37c749713f7b35c434a63f6850930e652474bd76a7d80a604cb0651dec8e3cd9'; sudoers_sha='1df904bda1d77c4abdd8b2c4bfe5375fb764a5c58a0e63ab1112f378d2e15833'
legacy_policy_sha='c22dce014c093f4490e879909b1384ce62e223867d892586483f985ba8824938'; legacy_approved_sha='e7e825d0c9a81c9514eb42aef12a56ad8c41729cfc9aa6f9fbaf345e9488b35a'; legacy_declared_target='/etc/sudoers.d/peilv-deploy'
legacy_v2_manifest_sha='e9c0380879cd8485644f4075cb1e000c60dab3c997120109d1ee5e6d9cf6099e'; legacy_v2_declared_target='/etc/peilv/trusted-deploy-v2.sha256'
sudoers_main="${PEILV_TCB_SUDOERS_MAIN:-/etc/sudoers}"; legacy_target="$sudoers_dir/peilv-deploy"
declare -a runtime_names=(deploy-production.sh production-preflight.sh rollback-production.sh migration-contract.mjs deploy-operation-ledger.mjs peilv-control)
declare -a install_names=("${runtime_names[@]}" peilv-sudoers "$legacy_policy_name" "$manifest_name")
declare -a activation_names=("${runtime_names[@]}" peilv-sudoers "$legacy_policy_name" legacy-sudoers-retirement legacy-v2-manifest-retirement "$manifest_name")
declare -A destinations=(
 [deploy-production.sh]="$libexec/deploy-production.sh" [production-preflight.sh]="$libexec/production-preflight.sh"
 [rollback-production.sh]="$libexec/rollback-production.sh" [migration-contract.mjs]="$libexec/migration-contract.mjs"
 [deploy-operation-ledger.mjs]="$libexec/deploy-operation-ledger.mjs" [peilv-control]="$sbin/peilv-control"
 [peilv-sudoers]="$sudoers_dir/peilv" [$legacy_policy_name]="$etc/$legacy_policy_name" [legacy-sudoers-retirement]="$legacy_target" [legacy-v2-manifest-retirement]="$etc/trusted-deploy-v2.sha256" [$manifest_name]="$etc/$manifest_name")
declare -A modes=([deploy-production.sh]=755 [production-preflight.sh]=755 [rollback-production.sh]=755 [migration-contract.mjs]=755 [deploy-operation-ledger.mjs]=755 [peilv-control]=755 [peilv-sudoers]=440 [$legacy_policy_name]=644 [legacy-sudoers-retirement]=440 [legacy-v2-manifest-retirement]=644 [$manifest_name]=644)
declare -A operations=([legacy-sudoers-retirement]=retire [legacy-v2-manifest-retirement]=retire)
declare -A allowed_old=(
 [deploy-production.sh]=9462fbc771b07817ef0a320f58d0b352478b74af74506842077e4e2d0e9daaa5
 [production-preflight.sh]=90d89b973bba29365f035a44e13d53a9dd661a713aacdab25dd89a0b12b30493
 [rollback-production.sh]=2eabe478e3857e750f66344fa9ba09ea90ea72e6c7f1285c0ad216a8c1a50517
 [migration-contract.mjs]=4042a7c69e5aaa41bf26a9e55f72740be1213d8c6dedc5e95ae3573460042923
 [deploy-operation-ledger.mjs]=51ce940a01d5fac4f353cf23562c8a995937fc8670daa11c94d0004712628693
 [peilv-control]=5d4e408f2e72550cb783add81a892643613aacea91596853c6bed79bb048ec95
 [peilv-sudoers]=1df904bda1d77c4abdd8b2c4bfe5375fb764a5c58a0e63ab1112f378d2e15833
 [$manifest_name]=bb73c2d965c6fa8f3d62a57ed50597a493ce18da226e544f4a42790e5ae4d943
 [legacy-sudoers-retirement]="$legacy_approved_sha" [legacy-v2-manifest-retirement]="$legacy_v2_manifest_sha")

sync_dir(){ sync -f "$1" 2>/dev/null || sync -d "$1"; }
path_entry_exists(){ [[ -e "$1" || -L "$1" ]]; }
classify_entry(){
 local p="$1"
 if ! path_entry_exists "$p"; then printf absent
 elif [[ -L "$p" ]]; then printf symlink
 elif [[ -f "$p" ]]; then [[ "$(stat -c %h "$p")" == 1 ]] && printf regular || printf hardlink
 elif [[ -d "$p" ]]; then printf directory
 else printf special
 fi
}
require_absent(){ local kind; kind="$(classify_entry "$1")"; [[ "$kind" == absent ]] || { printf 'Unsafe occupied path (%s): %s\n' "$kind" "$1" >&2; return 78; }; }
hash_or_absent(){ local kind; kind="$(classify_entry "$1")"; if [[ "$kind" == absent ]]; then printf absent; elif [[ "$kind" == regular ]]; then sha256sum "$1"|awk '{print $1}'; else printf 'Unsafe non-regular path (%s): %s\n' "$kind" "$1" >&2; return 78; fi; }
safe_existing_dir(){ local p="$1" mode="$2"; [[ "$(classify_entry "$p")" == directory && "$(stat -c '%U:%G:%a' "$p")" == "root:root:$mode" ]]; }
existing_parent(){ local p="$1" kind; while true; do kind="$(classify_entry "$p")"; if [[ "$kind" == absent ]]; then p="$(dirname "$p")"; elif [[ "$kind" == directory ]]; then printf '%s\n' "$p"; return; else return 1; fi; done; }
write_journal(){
 local phase="$1" active="$2" sequence="$3"
 local temp="$journal.next-$$"; require_absent "$temp" || exit 78
 PHASE="$phase" ACTIVE="$active" SEQUENCE="$sequence" TX="$tx" JOURNAL="$journal" JOURNAL_TEMP="$temp" RECORDS="$(printf '%s\n' "${records[@]}")" CREATED="$(printf '%s\n' "${created_dirs[@]:-}")" node <<'NODE'
const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
const split=k=>(process.env[k]||"").split("\n").filter(Boolean);
const records=split("RECORDS").map(line=>{const [name,operation,target,backup,oldHash,newHash,existed]=line.split("|");return{name,operation,target,backup,oldHash,newHash,existed:existed==="1"}});
const body={schemaVersion:5,transactionId:process.env.TX,sequence:Number(process.env.SEQUENCE),phase:process.env.PHASE,activeObject:process.env.ACTIVE||null,records,createdDirectories:split("CREATED")};
body.digest=crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
const temp=process.env.JOURNAL_TEMP,fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
try{fs.writeFileSync(fd,JSON.stringify(body,null,2)+"\n");fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,process.env.JOURNAL);const d=fs.openSync(path.dirname(process.env.JOURNAL),"r");try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
NODE
}
validate_journal(){ JOURNAL="$journal" node <<'NODE'
const fs=require("node:fs"),crypto=require("node:crypto");const s=fs.lstatSync(process.env.JOURNAL);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>1048576||(process.platform!=="win32"&&((s.mode&511)!==384||s.uid!==0||s.gid!==0)))throw Error("unsafe journal");const j=JSON.parse(fs.readFileSync(process.env.JOURNAL,"utf8")),digest=j.digest;delete j.digest;if(j.schemaVersion!==5||!Number.isSafeInteger(j.sequence)||j.sequence<1||!Array.isArray(j.records)||!Array.isArray(j.createdDirectories)||digest!==crypto.createHash("sha256").update(JSON.stringify(j)).digest("hex"))throw Error("invalid journal digest");for(const r of j.records)if(!r.name||!['install','retire'].includes(r.operation)||!r.target||!r.backup||!/^(absent|[0-9a-f]{64})$/.test(r.oldHash)||!/^(absent|[0-9a-f]{64})$/.test(r.newHash)||(r.operation==='retire'&&r.newHash!=='absent')||(r.operation==='install'&&r.newHash==='absent'))throw Error("invalid journal record");
NODE
}
validate_journal_abi(){
 local expected_name expected_target expected_mode expected_operation row name operation target backup old new existed index=0
 [[ "$tx" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ && ${#rows[@]} == ${#activation_names[@]} ]] || return 1
 for expected_name in "${activation_names[@]}"; do
   row="${rows[$index]}"; IFS='|' read -r name operation target backup old new existed <<<"$row"
   expected_target="${destinations[$expected_name]}"; expected_mode="${modes[$expected_name]}"
   expected_operation="${operations[$expected_name]:-install}"
   [[ "$name" == "$expected_name" && "$operation" == "$expected_operation" && "$target" == "$expected_target" && "$backup" == "$expected_target.tcb-v3-old-$tx" ]] || return 1
   [[ "$existed" == 0 || "$existed" == 1 ]] || return 1
   [[ ( "$existed" == 0 && "$old" == absent ) || ( "$existed" == 1 && -n "${allowed_old[$name]:-}" && "$old" == "${allowed_old[$name]}" ) ]] || return 1
    [[ "$new" == absent || "$new" =~ ^[0-9a-f]{64}$ ]] || return 1
    [[ "$operation:$new" == retire:absent || ( "$operation" == install && "$new" != absent ) ]] || return 1
    if [[ "$operation" == install ]]; then [[ "$new" == "$(hash_or_absent "$stage/$name")" ]] || return 1; fi
  ((index+=1))
 done
}
seal_evidence(){
 local final_state="$1" evidence="$evidence_root/$tx" row name operation target backup old new existed evidence_file
 if path_entry_exists "$evidence"; then safe_existing_dir "$evidence" 700 || { printf 'Unsafe forensic evidence directory\n' >&2; exit 78; }; else install -d -o root -g root -m 700 "$evidence"; sync_dir "$evidence_root"; fi
 for row in "${records[@]}"; do IFS='|' read -r name operation target backup old new existed <<<"$row"; [[ "$existed" == 1 ]] || continue; evidence_file="$evidence/$name.old"; if ! path_entry_exists "$evidence_file"; then source="$backup"; [[ "$(hash_or_absent "$source")" == "$old" ]] || { [[ "$final_state" == old && "$(hash_or_absent "$target")" == "$old" ]] && source="$target" || { printf 'Forensic source cannot be proven: %s\n' "$name" >&2; exit 78; }; }; install -o root -g root -m 600 "$source" "$evidence_file"; sync -f "$evidence_file"; else [[ "$(classify_entry "$evidence_file")" == regular ]] || { printf 'Unsafe forensic evidence object\n' >&2; exit 78; }; fi; [[ "$(hash_or_absent "$evidence_file")" == "$old" ]] || { printf 'Forensic evidence hash mismatch\n' >&2; exit 78; }; done
 require_absent "$evidence/bundle.json" || exit 78; require_absent "$evidence/bundle.json.next-$$" || exit 78
 FINAL_STATE="$final_state" EVIDENCE="$evidence" TX="$tx" BUNDLE_TEMP="$evidence/bundle.json.next-$$" RECORDS="$(printf '%s\n' "${records[@]}")" MODES="$(for key in "${activation_names[@]}"; do printf '%s|%s\n' "$key" "${modes[$key]}"; done)" node <<'NODE'
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');const hash=file=>{try{const s=fs.lstatSync(file);return s.isFile()&&!s.isSymbolicLink()&&s.nlink===1?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):'absent'}catch(e){if(e.code==='ENOENT')return'absent';throw e}};const modes=Object.fromEntries((process.env.MODES||'').split('\n').filter(Boolean).map(line=>line.split('|')));const records=(process.env.RECORDS||'').split('\n').filter(Boolean).map(line=>{const [name,operation,target,backup,oldHash,newHash,existed]=line.split('|');return{name,operation,target,oldHash,newHash,existed:existed==='1',oldMetadata:existed==='1'?{owner:'root',group:'root',mode:modes[name],nlink:1}:null,finalSha256:hash(target)}});const body={schemaVersion:1,transactionId:process.env.TX,finalState:process.env.FINAL_STATE,records};body.digest=crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');const target=path.join(process.env.EVIDENCE,'bundle.json'),temp=process.env.BUNDLE_TEMP;fs.writeFileSync(temp,JSON.stringify(body,null,2)+'\n',{mode:0o600,flag:'wx'});const f=fs.openSync(temp,'r');try{fs.fsyncSync(f)}finally{fs.closeSync(f)}fs.renameSync(temp,target);const d=fs.openSync(process.env.EVIDENCE,'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
NODE
 sync_dir "$evidence_root"
}
recover_transaction(){
 validate_journal || { printf 'TCB journal is corrupt; manual assessment required\n' >&2; exit 78; }
 local recovery_sequence
 recovery_sequence="$(JOURNAL="$journal" node -e 'process.stdout.write(String(require(process.env.JOURNAL).sequence+1))')"
 tx="$(JOURNAL="$journal" node -e 'process.stdout.write(require(process.env.JOURNAL).transactionId)')"; records=(); created_dirs=()
 mapfile -t rows < <(JOURNAL="$journal" node -e 'const j=require(process.env.JOURNAL);for(const r of j.records)console.log([r.name,r.operation,r.target,r.backup,r.oldHash,r.newHash,r.existed?1:0].join("|"))')
 mapfile -t created_dirs < <(JOURNAL="$journal" node -e 'for(const d of require(process.env.JOURNAL).createdDirectories)console.log(d)')
 for row in "${rows[@]}"; do IFS='|' read -r name operation target backup old new existed <<<"$row"; records+=("$name|$operation|$target|$backup|$old|$new|$existed"); done
 validate_journal_abi || { printf 'TCB journal ABI or path set is invalid\n' >&2; exit 78; }
 evidence="$evidence_root/$tx"; evidence_kind="$(classify_entry "$evidence")"; [[ "$evidence_kind" == absent || "$evidence_kind" == directory ]] || { printf 'Unsafe forensic evidence directory\n' >&2; exit 78; }
 for row in "${rows[@]}"; do IFS='|' read -r name operation target backup old new existed <<<"$row"; hash_or_absent "$target" >/dev/null || exit 78; hash_or_absent "$backup" >/dev/null || exit 78; evidence_file="$evidence/$name.old"; evidence_kind="$(classify_entry "$evidence_file")"; [[ "$evidence_kind" == absent || "$evidence_kind" == regular ]] || { printf 'Unsafe forensic evidence object\n' >&2; exit 78; }; done
 bundle_kind="$(classify_entry "$evidence/bundle.json")"; [[ "$bundle_kind" == absent || "$bundle_kind" == regular ]] || { printf 'Unsafe forensic bundle\n' >&2; exit 78; }
 require_absent "$evidence/bundle.json.next-$$" || exit 78; require_absent "$journal.next-$$" || exit 78
 write_journal recovering '' "$recovery_sequence"
 local manifest_state=unknown row name target backup old new existed actual
  for row in "${rows[@]}"; do IFS='|' read -r name operation target backup old new existed <<<"$row"; [[ "$name" != "$manifest_name" ]] || { actual="$(hash_or_absent "$target")"; [[ "$actual" == "$new" ]] && manifest_state=new || { [[ "$actual" == "$old" || ( "$actual" == absent && "$(hash_or_absent "$backup")" == "$old" ) ]] && manifest_state=old; }; }; done
 if [[ "$manifest_state" == new ]]; then
    for row in "${rows[@]}"; do IFS='|' read -r name operation target backup old new existed <<<"$row"; [[ "$(hash_or_absent "$target")" == "$new" ]] || { printf 'Committed TCB generation is mixed; manual assessment required\n' >&2; exit 78; }; done
 else
   [[ "$manifest_state" == old ]] || { printf 'Manifest state cannot be proven; manual assessment required\n' >&2; exit 78; }
    for ((i=${#rows[@]}-1;i>=0;i--)); do IFS='|' read -r name operation target backup old new existed <<<"${rows[$i]}"; actual="$(hash_or_absent "$target")"; if [[ "$actual" == "$old" && "$(hash_or_absent "$backup")" == absent ]]; then :; elif [[ "$actual" == "$new" || ( "$actual" == absent && "$existed" == 1 ) ]]; then if [[ "$existed" == 1 ]]; then [[ "$(hash_or_absent "$backup")" == "$old" ]] || { printf 'Old generation backup cannot be proven\n' >&2; exit 78; }; mv -Tf "$backup" "$target"; else [[ "$actual" == absent ]] || rm -f -- "$target"; fi; sync_dir "$(dirname "$target")"; else printf 'TCB object state cannot be proven: %s\n' "$name" >&2; exit 78; fi; recovery_sequence=$((recovery_sequence+1)); write_journal recovering "$name" "$recovery_sequence"; [[ "${PEILV_TCB_RECOVERY_FAIL_AFTER:-}" != "$name" ]] || kill -KILL $$; done
  fi
   seal_evidence "$manifest_state"
   mapfile -t dirs < <(JOURNAL="$journal" node -e 'const j=require(process.env.JOURNAL);for(const d of [...j.createdDirectories].reverse())console.log(d)')
  for row in "${rows[@]}"; do IFS='|' read -r name operation target backup old new existed <<<"$row"; rm -f -- "$backup"; sync_dir "$(dirname "$backup")"; done
  rm -f -- "$journal"; sync_dir "$state_root"
  if [[ "$manifest_state" == old ]]; then for d in "${dirs[@]}"; do parent="$(dirname "$d")"; rmdir -- "$d" 2>/dev/null || true; sync_dir "$parent"; done; fi
 printf 'Host TCB v3 recovery completed: %s generation retained\n' "$manifest_state"
}

journal_kind="$(classify_entry "$journal")"
if [[ "$journal_kind" != absent ]]; then [[ "$journal_kind" == regular ]] || { printf 'Unsafe TCB journal path\n' >&2; exit 78; }; recover_transaction; [[ "$action" == recover ]] && exit 0; fi
[[ "$action" == activate ]] || { printf 'No durable TCB journal requires recovery\n' >&2; exit 1; }

# Validate every staged byte and ABI before touching existing host directory attributes.
for name in "${install_names[@]}"; do source="$stage/$name"; [[ -f "$source" && ! -L "$source" && "$(stat -c '%U:%G:%h:%a' "$source")" == "root:root:1:${modes[$name]}" ]] || { printf 'Unsafe staged TCB object: %s\n' "$name" >&2; exit 1; }; LC_ALL=C grep -q $'\r' "$source" && { printf 'CRLF is forbidden: %s\n' "$name" >&2; exit 1; } || true; done
(cd "$stage"; sha256sum -c "$manifest_name" --strict)
[[ "$(sha256sum "$stage/$manifest_name"|awk '{print $1}')" == "$manifest_sha" && "$(sha256sum "$stage/peilv-sudoers"|awk '{print $1}')" == "$sudoers_sha" && "$(sha256sum "$stage/$legacy_policy_name"|awk '{print $1}')" == "$legacy_policy_sha" ]]
mapfile -t legacy_policy <"$stage/$legacy_policy_name"
[[ ${#legacy_policy[@]} == 2 && "${legacy_policy[0]}" == "$legacy_approved_sha  $legacy_declared_target" && "${legacy_policy[1]}" == "$legacy_v2_manifest_sha  $legacy_v2_declared_target" ]] || { printf 'Legacy retirement policy is invalid\n' >&2; exit 1; }
bash -n "$stage/peilv-control"; bash -n "$stage/deploy-production.sh"; bash -n "$stage/production-preflight.sh"; bash -n "$stage/rollback-production.sh"
node --check "$stage/migration-contract.mjs"; node --check "$stage/deploy-operation-ledger.mjs"; visudo -cf "$stage/peilv-sudoers"

# Reject cross-device activation before any later environment-specific validation.
for name in "${install_names[@]}"; do target="${destinations[$name]}"; parent="$(existing_parent "$(dirname "$target")")" || { printf 'Missing trusted destination ancestry: %s\n' "$target" >&2; exit 1; }; [[ "$(stat -c %d "$stage/$name")" == "$(stat -c %d "$parent")" ]] || { printf 'Cross-device activation forbidden before mutation\n' >&2; exit 1; }; done

# Prove the prospective effective sudoers graph before any Host TCB target mutation.
shopt -s nullglob
for candidate in "$sudoers_dir"/peilv-deploy*; do [[ "$candidate" == "$legacy_target" ]] || { printf 'Unapproved legacy sudoers target: %s\n' "$candidate" >&2; exit 1; }; done
for candidate in "$etc"/trusted-deploy-v2.sha256*; do [[ "$candidate" == "$etc/trusted-deploy-v2.sha256" ]] || { printf 'Unapproved legacy v2 manifest target: %s\n' "$candidate" >&2; exit 1; }; done
shopt -u nullglob
legacy_old_hash=absent
if [[ -e "$legacy_target" || -L "$legacy_target" ]]; then
 [[ -f "$legacy_target" && ! -L "$legacy_target" && "$(stat -c '%U:%G:%a:%h' "$legacy_target")" == root:root:440:1 ]] || { printf 'Unsafe legacy sudoers metadata\n' >&2; exit 78; }
 legacy_old_hash="$(sha256sum "$legacy_target"|awk '{print $1}')"
 [[ "$legacy_old_hash" == "$legacy_approved_sha" ]] || { printf 'Unapproved legacy sudoers hash\n' >&2; exit 1; }
fi
legacy_v2_target="$etc/trusted-deploy-v2.sha256"
if [[ -e "$legacy_v2_target" || -L "$legacy_v2_target" ]]; then
 [[ -f "$legacy_v2_target" && ! -L "$legacy_v2_target" && "$(stat -c '%U:%G:%a:%h' "$legacy_v2_target")" == root:root:644:1 ]] || { printf 'Unsafe legacy v2 manifest metadata\n' >&2; exit 78; }
 [[ "$(sha256sum "$legacy_v2_target"|awk '{print $1}')" == "$legacy_v2_manifest_sha" ]] || { printf 'Unapproved legacy v2 manifest hash\n' >&2; exit 1; }
fi
expected_sudoers="$(mktemp "${TMPDIR:-/tmp}/peilv-sudoers-expected.XXXXXX")"; trap 'rm -f -- "$expected_sudoers"' EXIT
SUDOERS_MAIN="$sudoers_main" SUDOERS_DIR="$sudoers_dir" NEW_SUDOERS="$stage/peilv-sudoers" LEGACY_SUDOERS="$legacy_target" node >"$expected_sudoers" <<'NODE'
const fs=require('node:fs'),path=require('node:path');const main=path.resolve(process.env.SUDOERS_MAIN),dir=path.resolve(process.env.SUDOERS_DIR),target=path.join(dir,'peilv'),legacy=path.resolve(process.env.LEGACY_SUDOERS),seen=new Set();let injected=0;
function metadata(file,wantDirectory=false){const s=fs.lstatSync(file);if((wantDirectory?!s.isDirectory():!s.isFile())||s.isSymbolicLink()||(!wantDirectory&&s.nlink!==1)||(process.platform!=='win32'&&(s.uid!==0||s.gid!==0||(s.mode&0o022)!==0)))throw Error(`unsafe sudoers graph object: ${file}`)}
function visit(input){const file=path.resolve(input);if(file===legacy)return;if(seen.has(file))throw Error(`sudoers include cycle: ${file}`);seen.add(file);let text;if(file===target){text=fs.readFileSync(process.env.NEW_SUDOERS,'utf8');injected++}else{metadata(file);text=fs.readFileSync(file,'utf8')}for(const raw of text.split(/\n/)){const directive=raw.match(/^\s*(?:#|@)include/);const m=raw.match(/^\s*(?:#|@)include(dir)?\s+(?:"([^"]+)"|([^\s#]+))\s*$/);if(directive&&!m)throw Error(`unsupported sudoers include syntax: ${file}`);if(m){const include=path.resolve(m[2]||m[3]);if(m[1]){metadata(include,true);const names=new Set(fs.readdirSync(include).filter(x=>!x.includes('.')&&!x.endsWith('~')));if(include===dir)names.add('peilv');for(const name of [...names].sort())visit(path.join(include,name))}else visit(include);continue}const line=raw.replace(/\s+#.*$/,'').trim();if(file!==target&&line){if(/^(?:User|Runas|Host|Cmnd)_Alias\b/.test(line)&&/\bPEILV|peilv-|peilv-control/i.test(line))throw Error(`peilv authorization alias is not independently provable: ${file}`);if(/\/usr\/local\/sbin\/peilv-control|\bpeilv-(?:audit|deploy|rollback)\b/.test(line))throw Error(`conflicting peilv authorization: ${file}`)}process.stdout.write(raw+'\n')}seen.delete(file)}
visit(main);if(injected!==1)throw Error('new peilv sudoers is not included exactly once');
NODE
chmod 440 "$expected_sudoers"; visudo -cf "$expected_sudoers" >/dev/null

for name in "${install_names[@]}"; do target="${destinations[$name]}"; target_kind="$(classify_entry "$target")"; [[ "$target_kind" == absent ]] || [[ "$target_kind" == regular && "$(stat -c '%U:%G:%a:%h' "$target")" == "root:root:${modes[$name]}:1" ]] || { printf 'Unsafe existing TCB object: %s\n' "$target" >&2; exit 78; }; done
for name in "${activation_names[@]}"; do target="${destinations[$name]}"; old_hash="$(hash_or_absent "$target")"; [[ "$old_hash" == absent || ( -n "${allowed_old[$name]:-}" && "$old_hash" == "${allowed_old[$name]}" ) ]] || { printf 'Unapproved existing TCB hash: %s\n' "$name" >&2; exit 1; }; done
declare -a created_dirs=() missing_dirs=(); declare -a required_dirs=("$state_root|700" "$operation_root|700" "$result_root|700" "$evidence_root|700" "$sbin|755" "$libexec|755" "$etc|755" "$sudoers_dir|755")
for item in "${required_dirs[@]}"; do IFS='|' read -r dir mode <<<"$item"; if path_entry_exists "$dir"; then safe_existing_dir "$dir" "$mode" || { printf 'Unsafe existing directory: %s\n' "$dir" >&2; exit 78; }; else parent="$(dirname "$dir")"; [[ "$(classify_entry "$parent")" == directory ]] || { printf 'Missing trusted parent: %s\n' "$parent" >&2; exit 1; }; missing_dirs+=("$item"); fi; done
for item in "${missing_dirs[@]}"; do IFS='|' read -r dir mode <<<"$item"; parent="$(dirname "$dir")"; install -d -o root -g root -m "$mode" "$dir"; created_dirs+=("$dir"); sync_dir "$parent"; done
sync_dir "$stage"

tx="$(date -u +%Y%m%dT%H%M%SZ)-$$"
records=(); for name in "${activation_names[@]}"; do target="${destinations[$name]}"; operation="${operations[$name]:-install}"; backup="$target.tcb-v3-old-$tx"; temp="$target.next-v3-$tx"; existed=0; path_entry_exists "$target" && existed=1; require_absent "$backup" || exit 78; require_absent "$temp" || exit 78; [[ "$(stat -c %d "$(dirname "$target")")" == "$(stat -c %d "$(dirname "$backup")")" ]] || exit 1; new_hash=absent; [[ "$operation" == retire ]] || new_hash="$(hash_or_absent "$stage/$name")"; records+=("$name|$operation|$target|$backup|$(hash_or_absent "$target")|$new_hash|$existed"); done
evidence="$evidence_root/$tx"; evidence_kind="$(classify_entry "$evidence")"; [[ "$evidence_kind" == absent || "$evidence_kind" == directory ]] || { printf 'Unsafe forensic evidence directory\n' >&2; exit 78; }
for name in "${activation_names[@]}"; do require_absent "$evidence/$name.old" || exit 78; done
require_absent "$evidence/bundle.json" || exit 78; require_absent "$evidence/bundle.json.next-$$" || exit 78
sequence=1; write_journal prepared '' "$sequence"
for row in "${records[@]}"; do IFS='|' read -r name operation target backup old new existed <<<"$row"; temp="$target.next-v3-$tx"; if [[ "$operation" == install ]]; then install -o root -g root -m "${modes[$name]}" "$stage/$name" "$temp"; sync -f "$temp"; sync_dir "$(dirname "$temp")"; fi; path_entry_exists "$target" && { mv -T "$target" "$backup"; sync_dir "$(dirname "$backup")"; }; [[ "${PEILV_TCB_FAIL_AFTER:-}" != "$name:backup" ]] || kill -KILL $$; if [[ "$operation" == install ]]; then mv -T "$temp" "$target"; sync_dir "$(dirname "$target")"; fi; sequence=$((sequence+1)); write_journal activating "$name" "$sequence"; [[ "${PEILV_TCB_FAIL_AFTER:-}" != "$name" ]] || kill -KILL $$; done
for row in "${records[@]}"; do IFS='|' read -r name operation target backup old new existed <<<"$row"; [[ "$(hash_or_absent "$target")" == "$new" ]] || { printf 'Activated TCB verification failed\n' >&2; exit 78; }; done
seal_evidence new
for row in "${records[@]}"; do IFS='|' read -r name operation target backup old new existed <<<"$row"; rm -f -- "$backup"; sync_dir "$(dirname "$backup")"; done
rm -f -- "$journal"; sync_dir "$state_root"
printf 'Deploy Host TCB v3 activated with six-runtime exact set and legacy sudoers retired\n'
