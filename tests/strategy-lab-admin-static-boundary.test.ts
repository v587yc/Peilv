import { readFile } from "node:fs/promises";
import { describe,expect,it } from "vitest";
const file=new URL("../src/app/admin/strategies/lab/strategy-lab-view.tsx",import.meta.url);
describe("Strategy Lab UI static read-only boundary",()=>{
 it("does not aggregate ROI, hash, or latest revision in the browser",async()=>{const source=await readFile(file,"utf8");expect(source).not.toContain(".reduce(");expect(source).not.toMatch(/profitMicros\s*\//);expect(source).not.toMatch(/stakeMicros\s*\//);expect(source).not.toMatch(/createHash|createHmac|canonical/i);expect(source).not.toMatch(/sort\([^)]*revision|max\([^)]*revision/i)});
 it("cannot issue mutations or import trusted execution modules",async()=>{const source=await readFile(file,"utf8");expect(source).not.toMatch(/method\s*:\s*["'](?:POST|PATCH|DELETE)["']/);expect(source).not.toMatch(/from\s+["'][^"']*(?:strategy-[abc]|runtime|asian-settlement|settlement-calculator|canonical-json|postgres|admin-query-server)[^"']*["']/i)});
 it("has no mutation action buttons",async()=>{const source=await readFile(file,"utf8");for(const label of ["创建","启动","取消","执行","结算","发布","暂停","恢复","导出"])expect(source).not.toMatch(new RegExp(`<Button[^>]*>\\s*${label}\\s*</Button>`))});
});
