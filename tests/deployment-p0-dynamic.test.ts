import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
const exec=promisify(execFile);
describe("isolated P0 deployment fault injection",()=>{
 it("passes sandbox-only candidate and rollback scenarios",async()=>{const result=await exec("bash",["tests/candidate-stage-p0-dynamic.sh"],{cwd:process.cwd(),timeout:60000,env:{...process.env,PEILV_TEST_SANDBOX_ONLY:"1"}});expect(result.stderr).toBe("");expect(result.stdout).toContain("P0_DYNAMIC_PASS")},70000);
});
