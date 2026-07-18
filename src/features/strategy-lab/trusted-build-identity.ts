import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { strategyLabBuildIdSchema, strategyLabHashSchema } from "./policy-schemas";
import { parseReleaseManifest } from "@/lib/release-control/manifest";

export interface TrustedBuildIdentity { readonly buildId: string; readonly releaseId: string; readonly commitSha: string; readonly manifestDigest: string; readonly archiveSha256: string }
export interface TrustedBuildIdentityProvider { load(buildLookupKey: string): Promise<Readonly<TrustedBuildIdentity>> }

export class ReleaseManifestBuildIdentityProvider implements TrustedBuildIdentityProvider {
  constructor(private readonly manifestPath: string) {}
  async load(buildLookupKey: string): Promise<Readonly<TrustedBuildIdentity>> {
    const key = strategyLabBuildIdSchema.parse(buildLookupKey);
    const bytes = await readFile(this.manifestPath);
    const parsed = parseReleaseManifest(JSON.parse(bytes.toString("utf8")));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (parsed.buildId !== key || !parsed.archiveSha256 || !strategyLabHashSchema.safeParse(parsed.archiveSha256).success) throw new Error("untrusted build identity");
    return Object.freeze({ buildId: parsed.buildId, releaseId: parsed.releaseId, commitSha: parsed.commitSha, manifestDigest: digest, archiveSha256:parsed.archiveSha256 });
  }
}
