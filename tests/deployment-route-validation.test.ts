import { describe, expect, it } from "vitest";
import { validateCandidateBinding, validatePreflightBinding } from "@/lib/release-control/validation";
import type { GitHubArtifact, GitHubWorkflowRun } from "@/lib/github/github-actions-adapter";

const sha="a".repeat(40),releaseId=`r101-a2-${sha.slice(0,12)}`;
const run={id:101,run_attempt:2,name:"CI",display_title:"CI",event:"push",status:"completed",conclusion:"success",head_sha:sha,head_branch:"main",html_url:"https://example.test/run",created_at:"2026-07-14T00:00:00Z",updated_at:"2026-07-14T00:10:00Z"} as GitHubWorkflowRun;
const artifact={id:501,name:"peilv-candidate-101-2",size_in_bytes:1,expired:false,created_at:"2026-07-14T00:00:00Z",expires_at:"2026-07-15T00:00:00Z",workflow_run:{id:101,head_sha:sha}} as GitHubArtifact;

describe("deployment route immutable binding",()=>{
  it("accepts an exact candidate binding",()=>expect(validateCandidateBinding({run,artifact,runAttempt:2,artifactId:501,releaseId})).toBeNull());
  it.each([
    ["run",{run:{...run,id:102}}],
    ["attempt",{runAttempt:3}],
    ["sha",{run:{...run,head_sha:"b".repeat(40)}}],
    ["artifact",{artifactId:502}],
    ["artifact provenance",{artifact:{...artifact,workflow_run:{id:101,head_sha:"b".repeat(40)}}}],
    ["expired artifact",{artifact:{...artifact,expired:true}}],
  ])("rejects %s mismatch",(_name,change)=>expect(validateCandidateBinding({run,artifact,runAttempt:2,artifactId:501,releaseId,...change})).not.toBeNull());
  it("rejects preflight release mismatch and expiration",()=>{const requestId="00000000-0000-4000-8000-000000000001";const preflight={...run,id:202,run_attempt:1,display_title:`Preflight ${releaseId} · ${requestId}`,updated_at:"2026-07-14T00:00:00Z"};const result={...artifact,id:601,name:`preflight-result-${requestId}`,workflow_run:{id:202,head_sha:sha}};expect(validatePreflightBinding({run:preflight,artifact:result,releaseId:`r102-a2-${sha.slice(0,12)}`,now:Date.parse("2026-07-14T00:30:00Z")})).toMatch(/不匹配/);expect(validatePreflightBinding({run:preflight,artifact:result,releaseId,now:Date.parse("2026-07-14T02:00:01Z")})).toMatch(/有效期/);});
  it("requires the exact preflight artifact request and workflow identity",()=>{const requestId="00000000-0000-4000-8000-000000000001";const preflight={...run,id:202,run_attempt:1,display_title:`Preflight ${releaseId} · ${requestId}`,updated_at:"2026-07-14T00:00:00Z"};const result={...artifact,id:601,name:`preflight-result-${requestId}`,workflow_run:{id:202,head_sha:sha}};expect(validatePreflightBinding({run:preflight,artifact:result,releaseId,now:Date.parse("2026-07-14T00:30:00Z")})).toBeNull();expect(validatePreflightBinding({run:preflight,artifact:{...result,name:"preflight-result-00000000-0000-4000-8000-000000000002"},releaseId,now:Date.parse("2026-07-14T00:30:00Z")})).toMatch(/错配/);expect(validatePreflightBinding({run:preflight,artifact:{...result,workflow_run:{id:203,head_sha:sha}},releaseId,now:Date.parse("2026-07-14T00:30:00Z")})).toMatch(/错配/);});
});
