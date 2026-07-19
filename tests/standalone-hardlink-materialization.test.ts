import { execFile, spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
const exec=promisify(execFile), roots:string[]=[];
const materializer=path.resolve("scripts/release-materialize.mjs");
afterEach(async()=>Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))));
async function workspaceFixture(prefix="peilv-pnpm-hardlink-"){
 const workspace=await mkdtemp(path.join(os.tmpdir(),prefix));roots.push(workspace);
 const source=path.join(workspace,"standalone"),stage=path.join(workspace,"stage"),store=path.join(workspace,"node_modules",".pnpm","pkg@1","node_modules","pkg");
 await mkdir(source,{recursive:true});await mkdir(stage);await mkdir(store,{recursive:true});
 return {workspace,source,stage,store};
}
describe("trusted pnpm hardlink materialization",()=>{
 it("accepts a trusted pnpm source hardlink but emits single-link stage files",async()=>{
  const {workspace,source,stage,store}=await workspaceFixture();
  const storeFile=path.join(store,"index.js"),peer=path.join(store,"index.peer.js");await writeFile(storeFile,"module.exports='trusted'\n");await link(storeFile,peer);
  const sourceModules=path.join(source,"node_modules",".pnpm","pkg@1","node_modules","pkg");await mkdir(sourceModules,{recursive:true});
  const sourceFile=path.join(sourceModules,"index.js");await link(storeFile,sourceFile);
  expect((await stat(sourceFile)).nlink).toBeGreaterThan(1);
  await exec("node",[materializer,source,stage,workspace],{timeout:30_000});
  const output=path.join(stage,"node_modules",".pnpm","pkg@1","node_modules","pkg","index.js");
  expect(await readFile(output,"utf8")).toBe("module.exports='trusted'\n");
  expect((await stat(output)).nlink).toBe(1);
 },30_000);

 it("omits dependency source maps without weakening other forbidden-member rejection",async()=>{
  const {workspace,source,stage}=await workspaceFixture("peilv-source-map-");
  await mkdir(path.join(source,"node_modules","pkg"),{recursive:true});
  await writeFile(path.join(source,"node_modules","pkg","index.js"),"module.exports=1\n");
  await writeFile(path.join(source,"node_modules","pkg","index.js.map"),"{}\n");
  await exec("node",[materializer,source,stage,workspace],{timeout:30_000});
  expect(await readFile(path.join(stage,"node_modules","pkg","index.js"),"utf8")).toBe("module.exports=1\n");
  await expect(stat(path.join(stage,"node_modules","pkg","index.js.map"))).rejects.toThrow();
 },30_000);

 it("rejects a source that changes while the same descriptor is being copied",async()=>{
  const {workspace,source,stage}=await workspaceFixture("peilv-changing-source-");
  const sourceFile=path.join(source,"large.bin");await writeFile(sourceFile,Buffer.alloc(128*1024*1024,0x41));
  const mutator=spawn(process.execPath,["-e",`const fs=require('node:fs');const file=process.argv[1];const end=Date.now()+10000;while(Date.now()<end){const now=new Date();fs.utimesSync(file,now,now)}`,sourceFile],{stdio:"ignore"});
  const child=spawn(process.execPath,[materializer,source,stage,workspace],{stdio:["ignore","pipe","pipe"]});
  const result=await new Promise<{code:number|null,stderr:string}>(resolve=>{let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);child.on("close",code=>resolve({code,stderr}));});
  mutator.kill();
  expect(result.code).not.toBe(0);expect(result.stderr).toMatch(/Source changed (?:before|during) copy/);
  await expect(stat(path.join(stage,"large.bin"))).rejects.toThrow();
 },60_000);

 it("rejects external symlink targets and source roots outside the workspace",async()=>{
  const {workspace,source,stage}=await workspaceFixture("peilv-external-link-");
  const external=await mkdtemp(path.join(os.tmpdir(),"peilv-external-target-"));roots.push(external);
  const externalFile=path.join(external,"outside.js");await writeFile(externalFile,"outside\n");
  try { await symlink(externalFile,path.join(source,"outside.js"),process.platform==="win32"?"file":undefined); }
  catch (error) { if ((error as NodeJS.ErrnoException).code==="EPERM") return; throw error; }
  await expect(exec("node",[materializer,source,stage,workspace],{timeout:30_000})).rejects.toMatchObject({stderr:expect.stringContaining("escapes allowed dependency roots")});
  await rm(path.join(source,"outside.js"));
  const externalPeer=path.join(external,"outside-peer.js");await link(externalFile,externalPeer);
  await symlink(externalPeer,path.join(source,"outside-hardlink.js"),process.platform==="win32"?"file":undefined);
  await expect(exec("node",[materializer,source,stage,workspace],{timeout:30_000})).rejects.toMatchObject({stderr:expect.stringContaining("escapes allowed dependency roots")});
  const externalStage=path.join(external,"stage");await mkdir(externalStage);
  await expect(exec("node",[materializer,external,externalStage,workspace],{timeout:30_000})).rejects.toMatchObject({stderr:expect.stringContaining("Standalone source must be inside the workspace")});
  },30_000);

  it("resolves pnpm-style relative multi-level internal links",async()=>{
   const {workspace,source,stage}=await workspaceFixture("peilv-semver-links-");
   const store=path.join(workspace,"node_modules","semver@7.7.3","node_modules","semver");
   await mkdir(store,{recursive:true}); await writeFile(path.join(store,"index.js"),"module.exports='semver'\n");
   const pnpmLinks=path.join(source,"node_modules",".pnpm","node_modules"); await mkdir(pnpmLinks,{recursive:true});
   try { await symlink("../../../../node_modules/semver@7.7.3/node_modules/semver",path.join(pnpmLinks,"semver")); }
   catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
   const nested=path.join(source,"node_modules","alias"); await mkdir(nested,{recursive:true});
   try { await symlink("../.pnpm/node_modules/semver",path.join(nested,"semver")); }
   catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
   await exec("node",[materializer,source,stage,workspace],{timeout:30_000});
   expect(await readFile(path.join(stage,"node_modules",".pnpm","node_modules","semver","index.js"),"utf8")).toBe("module.exports='semver'\n");
   expect(await readFile(path.join(stage,"node_modules","alias","semver","index.js"),"utf8")).toBe("module.exports='semver'\n");
  },30_000);

  it("rejects dangling and cyclic links separately",async()=>{
   const {workspace,source,stage}=await workspaceFixture("peilv-link-errors-");
   try { await symlink("missing-target",path.join(source,"dangling.js")); }
   catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
   await expect(exec("node",[materializer,source,stage,workspace],{timeout:30_000})).rejects.toMatchObject({stderr:expect.stringContaining("Dangling symlink rejected")});
   await rm(path.join(source,"dangling.js"));
   await symlink("cycle-b",path.join(source,"cycle-a")); await symlink("cycle-a",path.join(source,"cycle-b"));
   await expect(exec("node",[materializer,source,stage,workspace],{timeout:30_000})).rejects.toMatchObject({stderr:expect.stringContaining("Cyclic symlink rejected")});
  },30_000);
});
