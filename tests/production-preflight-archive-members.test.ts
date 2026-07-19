import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const python = process.platform === "win32" ? { command: "py", prefix: ["-3"] } : { command: "python3", prefix: [] };
const workflowPath = new URL("../.github/workflows/production-preflight.yml", import.meta.url);
let selectorSource = "";
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const match = workflow.match(/python3 - "\$archive" verified-release <<'PY'\n([\s\S]*?)\n {10}PY/);
  expect(match, "embedded archive member selector").not.toBeNull();
  selectorSource = match![1].replace(/^ {10}/gm, "");

  expect(workflow).toContain('const external = JSON.parse(fs.readFileSync(process.env.EXTERNAL_MANIFEST, "utf8"));');
  expect(workflow).toContain('const internal = JSON.parse(fs.readFileSync(process.env.INTERNAL_MANIFEST, "utf8"));');
  expect(workflow).toContain('const migrations = JSON.parse(fs.readFileSync(process.env.MIGRATION_MANIFEST, "utf8"));');
  expect(workflow).toContain("JSON.stringify(external.migrations) !== JSON.stringify(internal.migrations)");
  expect(workflow).toContain("JSON.stringify(internal.migrations) !== JSON.stringify(migrations.migrations)");
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type FixtureMember = { name: string; content?: string; type?: "file" | "directory" | "symlink" };

async function runSelector(members: FixtureMember[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "preflight-members-"));
  temporaryDirectories.push(directory);
  const fixturePath = path.join(directory, "fixture.json");
  const archivePath = path.join(directory, "candidate.tar.gz");
  const outputPath = path.join(directory, "verified-release");
  const selectorPath = path.join(directory, "selector.py");
  const creatorPath = path.join(directory, "create.py");
  await writeFile(fixturePath, JSON.stringify(members));
  await writeFile(selectorPath, selectorSource);
  await writeFile(creatorPath, String.raw`
import io, json, sys, tarfile
members = json.load(open(sys.argv[1], encoding="utf-8"))
with tarfile.open(sys.argv[2], "w:gz") as archive:
    for item in members:
        info = tarfile.TarInfo(item["name"])
        if item.get("type") == "directory":
            info.type = tarfile.DIRTYPE
            archive.addfile(info)
        elif item.get("type") == "symlink":
            info.type = tarfile.SYMTYPE
            info.linkname = "release-manifest.json"
            archive.addfile(info)
        else:
            content = item.get("content", "{}").encode()
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
`);
  await exec(python.command, [...python.prefix, creatorPath, fixturePath, archivePath]);
  await writeFile(path.join(directory, ".keep"), "");
  const result = await exec(python.command, [...python.prefix, selectorPath, archivePath, outputPath]).then(
    value => ({ status: 0, ...value }),
    error => ({ status: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }),
  );
  return { ...result, outputPath };
}

const canonical = [
  { name: "release-manifest.json", content: '{"source":"internal"}' },
  { name: "migrations/manifest.json", content: '{"migrations":[]}' },
];

describe("production preflight archive manifest selection", () => {
  it("accepts canonical archive member names without ./", async () => {
    const result = await runSelector(canonical);
    expect(result.status).toBe(0);
    expect(await readFile(path.join(result.outputPath, "release-manifest.json"), "utf8")).toContain("internal");
    expect(await readFile(path.join(result.outputPath, "migrations/manifest.json"), "utf8")).toContain("migrations");
  });

  it("accepts the legacy-compatible ./ member names", async () => {
    const result = await runSelector([
      { name: "./", type: "directory" },
      ...canonical.map(member => ({ ...member, name: `./${member.name}` })),
    ]);
    expect(result.status).toBe(0);
  });

  it.each([
    ["duplicate normalized manifest", [...canonical, { name: "./release-manifest.json" }]],
    ["duplicate migration manifest", [...canonical, { name: "./migrations/manifest.json" }]],
    ["path traversal", [...canonical, { name: "../release-manifest.json" }]],
    ["prefixed collision", [...canonical, { name: "prefix/release-manifest.json" }]],
    ["fuzzy suffix collision", [...canonical, { name: "fake-release-manifest.json" }]],
    ["prefixed migration collision", [...canonical, { name: "prefix/migrations/manifest.json" }]],
  ])("rejects %s", async (_name, members) => {
    const result = await runSelector(members);
    expect(result.status).not.toBe(0);
  });
});
