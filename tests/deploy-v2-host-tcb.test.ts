import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe,expect,it } from "vitest";

const runtimePaths:Record<string,string>={
  "peilv-control":"infra/deploy/peilv-control",
  "production-preflight.sh":"scripts/production-preflight.sh",
  "deploy-production.sh":"scripts/deploy-production.sh",
  "rollback-production.sh":"scripts/rollback-production.sh",
  "migration-contract.mjs":"scripts/migration-contract.mjs",
  "deploy-operation-ledger.mjs":"scripts/deploy-operation-ledger.mjs",
};
const hash=(value:string)=>createHash("sha256").update(value.replace(/\r\n/g,"\n")).digest("hex");

describe("Host TCB v3 six-runtime exact-set",()=>{
  it("uses one exact six-runtime set in manifest, controller and bootstrap",async()=>{
    const manifest=(await readFile("infra/deploy/trusted-host-tcb-v3.sha256","utf8")).trim().split(/\r?\n/);
    expect(manifest.map(line=>line.split(/\s+/)[1])).toEqual(Object.keys(runtimePaths));
    const control=await readFile("infra/deploy/peilv-control","utf8"),bootstrap=await readFile("infra/deploy/bootstrap-deploy-v3.sh","utf8");
    expect(control).toContain("((${#seen[@]} == 6))");
    for(const name of Object.keys(runtimePaths)){expect(control).toContain(name);expect(bootstrap).toContain(name)}
    expect(bootstrap).toContain("legacy-sudoers-retirement-v1.sha256");
    expect(bootstrap).toContain("legacy-sudoers-retirement");
  });
  it("freezes every runtime hash",async()=>{
    const manifest=(await readFile("infra/deploy/trusted-host-tcb-v3.sha256","utf8")).trim().split(/\r?\n/);
    for(const line of manifest){const [expected,name]=line.split(/\s+/);expect(hash(await readFile(runtimePaths[name],"utf8"))).toBe(expected)}
  });
  it("binds all privileged commands to versioned controller ABI",async()=>{
    const sudoers=await readFile("infra/deploy/peilv-sudoers","utf8"),control=await readFile("infra/deploy/peilv-control","utf8");
    for(const command of ["preflight-v3","deploy-v3","deploy-status-v2","rollback-v2","rollback-status-v2"]){expect(sudoers).toContain(`peilv-control ${command} *`);expect(control).toContain(`${command}:`)}
    expect(sudoers).not.toMatch(/peilv-control (deploy|preflight|rollback) \*/);
  });
  it("holds deploy, TCB and request locks in order without runtime relock",async()=>{
    const control=await readFile("infra/deploy/peilv-control","utf8"),preflight=await readFile("scripts/production-preflight.sh","utf8"),rollback=await readFile("scripts/rollback-production.sh","utf8");
    const dispatch=control.indexOf('caller="${SUDO_USER:-}"');const global=control.indexOf("exec 9>",dispatch),tcb=control.indexOf("exec 8>",global),request=control.indexOf("acquire_request_lock",tcb);expect(global).toBeLessThan(tcb);expect(tcb).toBeLessThan(request);
    expect(preflight).not.toMatch(/exec [789]>/);expect(rollback).not.toMatch(/exec [789]>/);
  });
  it("continuously audits sudoers and rejects any coexisting controller grant",async()=>{
    const control=await readFile("infra/deploy/peilv-control","utf8");expect(control).toContain("visudo -c");expect(control).toContain("sudo -l -U");expect(control).toContain("Unexpected effective peilv-control authorization count");expect(control).toContain("/etc/sudoers.d -xdev -type f");expect(control).toContain("Conflicting peilv-control sudo authorization coexists");expect(control).toContain("/etc/sudoers.d/peilv-deploy");expect(control).toContain("Legacy peilv sudo authorization still exists");expect(control).toContain("/etc/peilv/trusted-deploy-v2.sha256");
  });
  it("freezes one exact legacy retirement target and approved production hash",async()=>{
    const policy=(await readFile("infra/deploy/legacy-sudoers-retirement-v1.sha256","utf8")).trim();
    expect(policy).toBe("e7e825d0c9a81c9514eb42aef12a56ad8c41729cfc9aa6f9fbaf345e9488b35a  /etc/sudoers.d/peilv-deploy\ne9c0380879cd8485644f4075cb1e000c60dab3c997120109d1ee5e6d9cf6099e  /etc/peilv/trusted-deploy-v2.sha256");
    const bootstrap=await readFile("infra/deploy/bootstrap-deploy-v3.sh","utf8");
    expect(bootstrap).toContain("legacy_policy_sha='c22dce014c093f4490e879909b1384ce62e223867d892586483f985ba8824938'");
    expect(bootstrap).toContain("schemaVersion:5");
    expect(bootstrap).toContain("operation==='retire'");
    expect(bootstrap).toContain("[legacy-v2-manifest-retirement]=\"$legacy_v2_manifest_sha\"");
    expect(bootstrap).toContain("Unapproved existing TCB hash");
    expect(bootstrap).toContain("oldMetadata");
    expect(bootstrap).toContain("tcb-forensics");
  });
  it("durably commits deploy and rollback status-v2 results before finishing the operation ledger",async()=>{
    const writer=await readFile("scripts/deploy-operation-ledger.mjs","utf8");expect(writer).toContain('command==="append-deployment-event"');expect(writer).toContain('command==="write-result-v2"');expect(writer).toContain("fs.constants.O_EXCL|fs.constants.O_NOFOLLOW");expect(writer).toContain("fs.fsyncSync(fd)");expect(writer).toContain("fs.renameSync(temp,target)");expect(writer).toContain("fs.fsyncSync(directory)");expect(writer).toContain('if(error.code!=="ENOENT")throw error');
    for(const name of ["scripts/deploy-production.sh","scripts/rollback-production.sh"]){const source=await readFile(name,"utf8"),finish=source.lastIndexOf('"$operation_ledger" finish');expect(source.match(/write-result-v2/g)?.length).toBe(name.includes("deploy-production")?3:2);expect(source.match(/append-deployment-event/g)?.length).toBe(1);expect(source).not.toContain("Unsafe deployment ledger metadata");expect(finish).toBeGreaterThan(source.lastIndexOf("write-result-v2"));}
  });



  it("accepts production mixed baseline hashes in allowed_old window", async () => {
    const bootstrap = await readFile("infra/deploy/bootstrap-deploy-v3.sh", "utf8");
    expect(bootstrap).toContain("is_allowed_old()");
    expect(bootstrap).toMatch(/local name="\$1"/);
    expect(bootstrap).toMatch(/local hash="\$2"/);
    expect(bootstrap).toMatch(/local allowed=" \$\{allowed_old\[\$name\]:-\} "/);
    for (const hash of [
      "f92dfea3711d50d64e0fa70c15ffa94c994bd998fbeee9045004a0c6e6140f1c",
      "a6b15f553a78d30da95fe6ecaebe74efaaafd7c14b33728f6d35feb54c26abef",
      "08d60222c013dc15ff0495af22ddd51299490cc32e4c5fc219384ea362b81a26",
      "a7a1655eab7a72b692e671849b7ecb3702fcd0d9ef89394bd4e2b9308de64f35",
      "5d4e408f2e72550cb783add81a892643613aacea91596853c6bed79bb048ec95",
      "9e3224216f45c69f8c53990c09e6e12db5ea7b79e5116936f1eac1943db9b827",
    ]) expect(bootstrap).toContain(hash);
    expect(bootstrap).not.toContain("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

});
