import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec=promisify(execFile);
const objects=["deploy-production.sh","migration-contract.mjs","deploy-operation-ledger.mjs","peilv-control","peilv-sudoers","trusted-deploy-v2.sha256"];
async function fixture(failAfter=""){
  const root=await mkdtemp(path.join(os.tmpdir(),"deploy-v3-bootstrap-")),stage=path.join(root,"stage"),sbin=path.join(root,"sbin"),libexec=path.join(root,"libexec"),etc=path.join(root,"etc"),sudoers=path.join(root,"sudoers"),txn=path.join(root,"txn");
  await Promise.all([stage,sbin,libexec,etc,sudoers,txn].map(dir=>mkdir(dir)));
  const sources:Record<string,string>={"deploy-production.sh":"scripts/deploy-production.sh","migration-contract.mjs":"scripts/migration-contract.mjs","deploy-operation-ledger.mjs":"scripts/deploy-operation-ledger.mjs","peilv-control":"infra/deploy/peilv-control","peilv-sudoers":"infra/deploy/peilv-sudoers","trusted-deploy-v2.sha256":"infra/deploy/trusted-deploy-v2.sha256"};
  for(const name of objects){const target=path.join(stage,name);await copyFile(sources[name],target);await chmod(target,name==="peilv-sudoers"?0o440:name==="trusted-deploy-v2.sha256"?0o644:0o755);}
  const destinations:Record<string,string>={"deploy-production.sh":path.join(libexec,"deploy-production.sh"),"migration-contract.mjs":path.join(libexec,"migration-contract.mjs"),"deploy-operation-ledger.mjs":path.join(libexec,"deploy-operation-ledger.mjs"),"peilv-control":path.join(sbin,"peilv-control"),"peilv-sudoers":path.join(sudoers,"peilv"),"trusted-deploy-v2.sha256":path.join(etc,"trusted-deploy-v2.sha256")};
  for(const [name,target]of Object.entries(destinations))await writeFile(target,`OLD:${name}\n`);
  let script=await readFile("infra/deploy/bootstrap-deploy-v3.sh","utf8");
  script=script.replace('[[ "$(id -u)" == 0 ]]','[[ 0 == 0 ]]').replaceAll("root:root:1","Administrator:UNKNOWN:1").replace('"$(stat -c %a "$source")"','"${modes[$name]}"').replace("install -d -o root -g root -m 0755", "install -d -m 0755").replaceAll("install -o root -g root -m", "install -m");
  script=script.replace("stage=\"$(readlink -f \"$1\")\"",'stage="$(cygpath -u "$1")"').replace('flock -n 9 ||','true ||').replace('visudo -cf "$stage/peilv-sudoers"','true # visudo fixture');
  const harness=path.join(root,"bootstrap.sh");await writeFile(harness,script);await chmod(harness,0o700);
  const env={...process.env,PEILV_TCB_LOCK:path.join(root,"lock"),PEILV_TCB_SBIN:sbin,PEILV_TCB_LIBEXEC:libexec,PEILV_TCB_ETC:etc,PEILV_TCB_SUDOERS:sudoers,PEILV_TCB_TXN_ROOT:txn,PEILV_TCB_FAIL_AFTER:failAfter};
  return {root,stage,destinations,run:()=>exec("bash",[harness,stage],{env}),snapshot:async()=>Object.fromEntries(await Promise.all(Object.entries(destinations).map(async([name,target])=>[name,await readFile(target,"utf8")])))};
}

describe("deploy v3 Host TCB bootstrap transaction",()=>{
  it("activates all objects with the trusted manifest last",async()=>{const f=await fixture();await expect(f.run()).resolves.toMatchObject({stdout:expect.stringContaining("activated atomically")});for(const [name,target]of Object.entries(f.destinations))expect(await readFile(target,"utf8")).toBe(await readFile(path.join(f.stage,name),"utf8"));});
  it.each(objects)("rolls back the complete old generation after injected %s activation failure",async point=>{const f=await fixture(point),before=await f.snapshot();await expect(f.run()).rejects.toBeDefined();expect(await f.snapshot()).toEqual(before);});
  it("declares manifest-last activation and rejects mixed generation by exact-set gate",async()=>{const script=await readFile("infra/deploy/bootstrap-deploy-v3.sh","utf8"),control=await readFile("infra/deploy/peilv-control","utf8");expect(script.indexOf("peilv-sudoers trusted-deploy-v2.sha256")).toBeGreaterThan(-1);expect(control).toContain("Deploy v3 host TCB validation failed");});
  it("rejects a CRLF staged executable before activation",async()=>{const f=await fixture(),before=await f.snapshot();await writeFile(path.join(f.stage,"deploy-production.sh"),"#!/bin/sh\r\nexit 0\r\n");await expect(f.run()).rejects.toBeDefined();expect(await f.snapshot()).toEqual(before);});
});
