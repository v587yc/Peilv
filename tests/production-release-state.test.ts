import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSchemaCompatibleRollback, loadProductionReleaseState, previousReleaseFromLedger } from "@/lib/release-control/production-state";

const migration=(version:string,safe=true)=>({file:`${version}.sql`,version,sha256:"a".repeat(64),codeRollbackSafe:safe});
const manifest=(releaseId:string,migrations:ReturnType<typeof migration>[])=>({schemaVersion:1 as const,repositoryId:1,repository:"owner/repo",commitSha:`${releaseId.slice(-12)}${"b".repeat(28)}`,releaseId,sourceRunId:Number(releaseId.match(/^r(\d+)/)?.[1]),sourceRunAttempt:1,buildId:"build",archiveFile:`peilv-${releaseId}.tar.gz`,archiveSha256:null,createdAt:"2026-07-14T00:00:00Z",migrations,files:[{path:"server.js",sha256:"c".repeat(64)}]});
const run=(title:string,created:string)=>({display_title:title,status:"completed",conclusion:"success",created_at:created});

describe("trusted production release state",()=>{
  it("uses successful rollback as current history edge",()=>{const current="r10-a1-aaaaaaaaaaaa",newer="r11-a1-bbbbbbbbbbbb";expect(previousReleaseFromLedger([run(`Rollback ${newer} to ${current} · id`,`2026-07-14T03:00:00Z`),run(`Deploy ${newer} · id`,`2026-07-14T02:00:00Z`)],current)).toBe(newer);});
  it("rejects an unsafe rollback migration",()=>{const current=manifest("r11-a1-bbbbbbbbbbbb",[migration("0001_base"),migration("0002_breaking",false)]);const target=manifest("r10-a1-aaaaaaaaaaaa",[migration("0001_base")]);expect(isSchemaCompatibleRollback(current,target,new Set(["0001_base","0002_breaking"]))).toBe(false);});
  it("requires target migrations to match and be applied",()=>{const current=manifest("r11-a1-bbbbbbbbbbbb",[migration("0001_base")]);const target=manifest("r10-a1-aaaaaaaaaaaa",[migration("0001_base")]);expect(isSchemaCompatibleRollback(current,target,new Set(["0001_base"]))).toBe(true);expect(isSchemaCompatibleRollback(current,target,new Set())).toBe(false);});
  it("reads current from installed symlink and previous from matching local ledger",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"peilv-release-"));const current="r11-a1-bbbbbbbbbbbb",previous="r10-a1-aaaaaaaaaaaa";for(const id of [current,previous]){await mkdir(path.join(root,"releases",id),{recursive:true});await writeFile(path.join(root,"releases",id,"release-manifest.json"),JSON.stringify(manifest(id,[migration("0001_base")])));}await symlink(path.join(root,"releases",current),path.join(root,"current"),"junction");await writeFile(path.join(root,"deployment-ledger.json"),JSON.stringify({schemaVersion:1,events:[{kind:"deploy",releaseId:current,previousReleaseId:previous,requestId:"request",completedAt:"2026-07-14T01:00:00Z"}]}));const client={from:()=>({select:async()=>({data:[{version:"0001_base"}],error:null})})} as never;await expect(loadProductionReleaseState({operations:[],client,basePath:root})).resolves.toMatchObject({currentRelease:current,previousRelease:previous,installedReleaseIds:[current,previous]});});
});
