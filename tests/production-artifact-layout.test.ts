import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_CONTENT_MISSING, ARTIFACT_LAYOUT_INVALID, validateArtifactLayout } from "../scripts/validate-artifact-layout.mjs";

const temporaryDirectories: string[] = [];
const artifactName = "peilv-candidate-101-2";
const files = ["peilv-release.tar.gz", "peilv-release.tar.gz.sha256", "release-manifest-release.json"];

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

async function root() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "artifact-layout-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function nested(contents = files) {
  const directory = await root();
  const candidate = path.join(directory, artifactName);
  await mkdir(candidate);
  await Promise.all(contents.map(file => writeFile(path.join(candidate, file), file)));
  return { directory, candidate };
}

function exitCode(error: unknown) { return (error as Error & { exitCode?: number }).exitCode; }

describe("production artifact action layout", () => {
  it("accepts only the exact nested download-artifact v4 layout", async () => {
    const fixture = await nested();
    expect(validateArtifactLayout(fixture.directory, artifactName, files)).toBe(fixture.candidate);
  });

  it("does not misread a legacy flat layout", async () => {
    const directory = await root();
    await Promise.all(files.map(file => writeFile(path.join(directory, file), file)));
    expect(() => validateArtifactLayout(directory, artifactName, files)).toThrow();
    try { validateArtifactLayout(directory, artifactName, files); } catch (error) { expect(exitCode(error)).toBe(ARTIFACT_LAYOUT_INVALID); }
  });

  it("classifies missing expected content independently", async () => {
    const fixture = await nested(files.slice(0, 2));
    try { validateArtifactLayout(fixture.directory, artifactName, files); } catch (error) { expect(exitCode(error)).toBe(ARTIFACT_CONTENT_MISSING); }
  });

  it.each([
    ["extra file", async (candidate: string) => writeFile(path.join(candidate, "unexpected.txt"), "x")],
    ["extra artifact directory", async (_candidate: string, directory: string) => mkdir(path.join(directory, "other-artifact"))],
    ["non-regular expected content", async (candidate: string) => { await rm(path.join(candidate, files[0])); await mkdir(path.join(candidate, files[0])); }],
  ])("rejects %s as a layout error", async (_name, mutate) => {
    const fixture = await nested();
    await mutate(fixture.candidate, fixture.directory);
    try { validateArtifactLayout(fixture.directory, artifactName, files); } catch (error) { expect(exitCode(error)).toBe(ARTIFACT_LAYOUT_INVALID); }
  });

  it.each(["../escape", "nested/name", "nested\\name", "."])("rejects path traversal artifact name %s", async name => {
    const fixture = await nested();
    expect(() => validateArtifactLayout(fixture.directory, name, files)).toThrow();
  });
});
