import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile), roots: string[] = [];
const helper = path.resolve("scripts/lib/trusted-release-verifier.sh");
const hash = "a".repeat(64);
const exact = ["verify-release.sh", "release-archive.py", "release-limits.json", "private-copy.mjs", "candidate-stage.sh", "candidate-lifecycle.sh", "deployment-budget.sh", "openresty-control"];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function validate(files: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "peilv-verifier-set-")); roots.push(root);
  const manifest = path.join(root, "manifest"); await writeFile(manifest, files.map(file => `${hash} ${file}`).join("\n") + "\n");
  return exec("bash", ["-c", 'source "$1"; verify_trusted_release_verifier_manifest "$2"', "bash", helper, manifest]);
}

async function normalize(lines: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "peilv-verifier-map-")); roots.push(root);
  const source = path.join(root, "source"), destination = path.join(root, "destination");
  await writeFile(source, lines.join("\n") + "\n");
  await exec("bash", ["-c", 'source "$1"; normalize_trusted_release_verifier_manifest "$2" "$3"', "bash", helper, source, destination]);
  return readFile(destination, "utf8");
}

describe("trusted verifier manifest exact set", () => {
  it("accepts exactly eight unique required entries", async () => { await expect(validate(exact)).resolves.toBeDefined(); });
  it.each([
    ["duplicate", [...exact, exact[0]]],
    ["missing", exact.slice(0, 3)],
    ["extra", [...exact.slice(0, 3), "unexpected.mjs"]],
  ])("rejects %s entries", async (_name, files) => { await expect(validate(files)).rejects.toBeDefined(); });

  it("maps release paths to the exact installed basenames", async () => {
    const releasePaths = [
      "scripts/verify-release.sh", "scripts/release-archive.py", "scripts/release-limits.json", "scripts/private-copy.mjs",
      "scripts/lib/candidate-stage.sh", "scripts/lib/candidate-lifecycle.sh", "scripts/lib/deployment-budget.sh", "scripts/lib/openresty-control.sh",
    ];
    const result = await normalize(releasePaths.map(file => `${hash} *${file}`));
    expect(result.trim().split("\n").map(line => line.split(" ")[1])).toEqual(exact);
  });

  it("rejects CRLF input rather than silently changing the trust manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "peilv-verifier-crlf-")); roots.push(root);
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    await writeFile(source, exact.map(file => `${hash} ${file}`).join("\r\n") + "\r\n");
    await expect(exec("bash", ["-c", 'source "$1"; normalize_trusted_release_verifier_manifest "$2" "$3"', "bash", helper, source, destination])).rejects.toBeDefined();
  });

  it("rejects malformed spacing in the SHA manifest", async () => {
    await expect(normalize(exact.map((file, index) => `${hash}${index === 0 ? "  " : " "}${file}`))).rejects.toBeDefined();
  });

  it("rejects a bundle hash mismatch", async () => {
    const source = await readFile(helper, "utf8");
    expect(source).toContain('sha256sum "$bundle_dir/$file"');
    expect(source).toContain('== "$expected"');
  });
});
