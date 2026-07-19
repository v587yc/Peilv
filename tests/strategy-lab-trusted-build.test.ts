import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { parseReleaseManifest } from "@/lib/release-control/manifest";
import { ReleaseManifestBuildIdentityProvider } from "@/features/strategy-lab/trusted-build-identity";

vi.mock("node:fs/promises",()=>({readFile:vi.fn()}));

const manifest={schemaVersion:1,repositoryId:123,repository:"owner/repo",commitSha:"a".repeat(40),releaseId:`r123-a1-${"a".repeat(12)}`,sourceRunId:123,sourceRunAttempt:1,buildId:"trusted-build",archiveFile:`peilv-r123-a1-${"a".repeat(12)}.tar.gz`,archiveSha256:"b".repeat(64),createdAt:"2026-07-17T10:00:00Z",migrations:[{file:"0021_strategy_lab_policy_and_artifacts.sql",version:"0021_strategy_lab_policy_and_artifacts",sha256:"d".repeat(64),codeRollbackSafe:false}],files:[{path:"server.js",sha256:"c".repeat(64)}]};
const bytes=()=>Buffer.from(JSON.stringify(manifest));

describe("Strategy Lab trusted release build identity",()=>{
 it("reuses the strict release manifest parser and binds the exact manifest bytes",async()=>{
  expect(parseReleaseManifest(manifest)).toEqual(manifest);
  vi.mocked(readFile).mockResolvedValue(bytes());
  await expect(new ReleaseManifestBuildIdentityProvider("release-manifest.json").load("trusted-build")).resolves.toEqual({buildId:"trusted-build",releaseId:manifest.releaseId,commitSha:manifest.commitSha,manifestDigest:createHash("sha256").update(bytes()).digest("hex"),archiveSha256:manifest.archiveSha256});
 });
 it.each([
  ["missing archive digest",{archiveSha256:null}],
  ["commit provenance mismatch",{commitSha:"d".repeat(40)}],
  ["release provenance mismatch",{releaseId:`r999-a1-${"a".repeat(12)}`}],
  ["artifact digest malformed",{archiveSha256:"bad"}],
 ])("fails closed for %s",async(_name,change)=>{vi.mocked(readFile).mockResolvedValue(Buffer.from(JSON.stringify({...manifest,...change})));await expect(new ReleaseManifestBuildIdentityProvider("release-manifest.json").load("trusted-build")).rejects.toBeDefined();});
 it("rejects missing files and lookup-key mismatch",async()=>{
  vi.mocked(readFile).mockRejectedValueOnce(new Error("missing"));
  await expect(new ReleaseManifestBuildIdentityProvider("missing.json").load("trusted-build")).rejects.toBeDefined();
  vi.mocked(readFile).mockResolvedValue(bytes());
  await expect(new ReleaseManifestBuildIdentityProvider("release-manifest.json").load("other-build")).rejects.toThrow(/untrusted/);
 });
 it("has no request header, body, or cookie input surface",()=>{expect(ReleaseManifestBuildIdentityProvider.prototype.load).toHaveLength(1);});
});
