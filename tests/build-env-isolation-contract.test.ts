import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
const read=(p:string)=>readFile(new URL(`../${p}`,import.meta.url),"utf8");
describe("build root environment isolation",()=>{
 it("isolates the root env before Next build and restores it through one cleanup trap",async()=>{const s=await read("scripts/build.sh");expect(s).toMatch(/\.env[\s\S]{0,500}(?:mv|rename|private|isolate)/i);expect(s).toMatch(/trap[^\n]*(?:EXIT|HUP|INT|TERM)/);for(const signal of ["EXIT","HUP","INT","TERM"]){expect(s).toContain(signal)}expect(s).toMatch(/restore[^\n]*(?:env|environment)|(?:env|environment)[^\n]*restore/i);});
 it("rejects any standalone environment file before and after final assembly",async()=>{const s=await read("scripts/build.sh"),build=s.indexOf("pnpm next build"),success=s.indexOf("Build completed successfully");const guards=[...s.matchAll(/find \.next\/standalone -name ['"]\.env\*['"]/g)].map(match=>match.index??-1);expect(guards).toHaveLength(2);for(const guard of guards){expect(guard).toBeGreaterThan(build);expect(guard).toBeLessThan(success);const block=s.slice(guard,guard+250);expect(block).toContain("Build rejected:");expect(block).toContain("environment file");}});
 it("never reads or prints the root env contents",async()=>{const s=await read("scripts/build.sh");expect(s).not.toMatch(/(?:cat|sed|awk|grep|source|\.)\s+[^\n]*\.env/);expect(s).not.toMatch(/set\s+-a|export\s+\$?\(?cat[^\n]*\.env/);});
});
