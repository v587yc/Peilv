import { execFile } from "node:child_process";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import os from "node:os";import path from "node:path";import { promisify } from "node:util";import { afterEach,describe,expect,it } from "vitest";
const exec=promisify(execFile),roots:string[]=[];const materializer=path.resolve("scripts/release-materialize.mjs"),verifier=path.resolve("scripts/verify-release.sh");
afterEach(async()=>Promise.all(roots.splice(0).map(x=>rm(x,{recursive:true,force:true}))));
async function temporary(){const root=await mkdtemp(path.join(os.tmpdir(),"peilv-env-injection-"));roots.push(root);return root}
describe("release environment injection rejection",()=>{
 it("rejects a manually injected standalone env during materialization",async()=>{const root=await temporary(),source=path.join(root,"source"),stage=path.join(root,"stage");await mkdir(source);await mkdir(stage);await mkdir(path.join(root,"node_modules"));await writeFile(path.join(source,".env"),"opaque-test-bytes\n");await expect(exec("node",[materializer,source,stage,root],{timeout:30_000})).rejects.toMatchObject({stderr:expect.stringContaining("Forbidden release member")});},30_000);
 it("rejects a manually injected env during final tree verification",async()=>{const root=await temporary();await writeFile(path.join(root,".env"),"opaque-test-bytes\n");await expect(exec("bash",[verifier,"--tree",root],{timeout:30_000})).rejects.toMatchObject({stderr:expect.stringContaining("forbidden")});},30_000);
});
