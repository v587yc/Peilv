import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const verifier = path.resolve("scripts/verify-release.sh");
const archiveTool = path.resolve("scripts/release-archive.py");
const roots: string[] = [];
const sha = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const bashPath = (value: string) => value.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");

async function shell(args: string[], expectFailure = false) {
  try {
    return await exec("bash", args, { cwd: process.cwd(), timeout: 90_000 });
  } catch (error) {
    if (expectFailure) return error as { stdout: string; stderr: string };
    throw error;
  }
}

async function fixture(emptyPublic = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "peilv-archive-security-")); roots.push(root);
  const tree = path.join(root, "tree");
  const files: Record<string, string> = {
    ".next/BUILD_ID": "build-security\n", ".next/routes-manifest.json": "{}\n", ".next/static/chunk.js": "static\n",
    "server.js": "console.log('trusted')\n",
    "package.json": `${JSON.stringify({ name: "fixture", scripts: { "admin:bootstrap": "node ./scripts/admin-bootstrap.mjs" } })}\n`,
    "scripts/admin-bootstrap.mjs": "if (process.argv.length > 2) { process.stderr.write('此命令不接受参数\\n'); process.exitCode = 1; }\n",
    "scripts/run-migrations.mjs": await readFile(path.resolve("scripts/run-migrations.mjs"), "utf8"),
    "infra/local-data/compose.yml": "services: {}\n", "infra/local-data/nginx/default.conf": "server {}\n",
    "infra/openresty/peilv.conf": "server {}\n",
    "infra/openresty/peilv-1panel-http.conf": "map x y { default z; }\n",
    "infra/openresty/peilv-1panel-root.conf": "location / {}\n",
    "infra/systemd/peilv.service": "[Service]\nEnvironment=HOSTNAME=127.0.0.1\nEnvironment=PORT=5000\nEnvironment=DEPLOY_RUN_PORT=5000\nExecStart=/usr/bin/node /opt/peilv/current/server.js\n",
    "infra/systemd/peilv-reconcile.service": "[Service]\n", "infra/systemd/peilv-reconcile.timer": "[Timer]\n",
    "infra/systemd/peilv-dispatch.service": "[Service]\n", "infra/systemd/peilv-dispatch.timer": "[Timer]\n",
    "migrations/0001_test.sql": "INSERT INTO schema_migrations(version, description) VALUES ('0001_test', 'test') ON CONFLICT DO NOTHING;\n",
  };
  if (!emptyPublic) files["public/index.txt"] = "public\n";
  for (const [name, content] of Object.entries(files)) { const target = path.join(tree, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
  if (emptyPublic) await mkdir(path.join(tree, "public"), { recursive: true });
  const migration = { file: "0001_test.sql", version: "0001_test", sha256: sha(files["migrations/0001_test.sql"]), codeRollbackSafe: true };
  await writeFile(path.join(tree, "migrations/manifest.json"), `${JSON.stringify({ schemaVersion: 1, migrations: [migration] })}\n`);
  const regular: { path: string; sha256: string }[] = [];
  async function walk(directory: string) { for (const entry of await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) await walk(full); else { const relative = path.relative(tree, full).split(path.sep).join("/"); regular.push({ path: relative, sha256: sha(await readFile(full)) }); } } }
  await walk(tree); regular.sort((a, b) => a.path.localeCompare(b.path));
  const releaseId = "r1-a1-aaaaaaaaaaaa";
  await writeFile(path.join(tree, "release-manifest.json"), `${JSON.stringify({ schemaVersion: 1, repositoryId: 1, repository: "owner/repo", commitSha: "a".repeat(40), releaseId, sourceRunId: 1, sourceRunAttempt: 1, buildId: "build-security", archiveFile: `peilv-${releaseId}.tar.gz`, archiveSha256: null, createdAt: new Date(0).toISOString(), migrations: [migration], files: regular })}\n`);
  const archive = path.join(root, `peilv-${releaseId}.tar.gz`);
  await exec("python", [archiveTool, "create", tree, archive], { cwd: process.cwd(), timeout: 30_000 });
  return { root, tree, archive, releaseId };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("trusted release archive boundary", () => {
  it("keeps using the private archive after the upload path is replaced", async () => {
    const good = await fixture(); const evil = await fixture();
    await writeFile(path.join(evil.tree, "server.js"), "console.log('evil')\n");
    const privateArchive = path.join(good.root, "private.tar.gz"); await cp(good.archive, privateArchive); await chmod(privateArchive, 0o600);
    await cp(evil.archive, good.archive);
    const extract = path.join(good.root, "extract"); await mkdir(extract);
    const digest = sha(await readFile(privateArchive));
    await shell([bashPath(verifier), "--archive", bashPath(privateArchive), digest, bashPath(extract), `peilv-${good.releaseId}.tar.gz`]);
    expect(await readFile(path.join(extract, "server.js"), "utf8")).toContain("trusted");
    await expect(readFile(path.join(extract, "evil-marker"), "utf8")).rejects.toThrow();
  }, 90_000);

  it("accepts a relative extraction directory in archive mode", async () => {
    const value = await fixture();
    const relativeRoot = await mkdtemp(path.join(process.cwd(), ".test-tmp-relative-release-")); roots.push(relativeRoot);
    const extract = path.join(relativeRoot, "extract"); await mkdir(extract);
    const relativeExtract = path.relative(process.cwd(), extract);
    await shell([bashPath(verifier), "--archive", bashPath(value.archive), sha(await readFile(value.archive)), bashPath(relativeExtract), `peilv-${value.releaseId}.tar.gz`]);
    expect(JSON.parse(await readFile(path.join(extract, "release-manifest.json"), "utf8")).archiveFile).toBe(`peilv-${value.releaseId}.tar.gz`);
  }, 90_000);

  it("rejects an empty required directory", async () => {
    const value = await fixture(true); const extract = path.join(value.root, "extract"); await mkdir(extract);
    const result = await shell([bashPath(verifier), "--archive", bashPath(value.archive), sha(await readFile(value.archive)), bashPath(extract), `peilv-${value.releaseId}.tar.gz`], true);
    expect(result.stderr).toContain("required non-empty directory");
  }, 90_000);

  it("rejects duplicate normalized archive members", async () => {
    const value = await fixture(); const archive = path.join(value.root, "duplicate.tar.gz");
    const code = `import gzip,tarfile,sys
root,out=sys.argv[1:3]
with gzip.GzipFile(out,'wb',mtime=0) as gz:
 with tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT) as tf:
  tf.add(root,arcname='.')
  tf.add(root+'/server.js',arcname='server.js')`;
    await exec("python", ["-c", code, value.tree, archive], { cwd: process.cwd(), timeout: 30_000 });
    const extract = path.join(value.root, "extract"); await mkdir(extract);
    const result = await shell([bashPath(verifier), "--archive", bashPath(archive), sha(await readFile(archive)), bashPath(extract), `peilv-${value.releaseId}.tar.gz`], true);
    expect(result.stderr).toContain("Duplicate normalized archive path");
  }, 90_000);

  it("rejects every manually injected environment file through the real Python verifier", async () => {
    const value = await fixture(); await writeFile(path.join(value.tree, ".env.manual"), "must-not-ship\n");
    const archive = path.join(value.root, "peilv-r1-a1-aaaaaaaaaaaa-injected.tar.gz");
    const code = `import gzip,tarfile,sys
root,out=sys.argv[1:3]
with gzip.GzipFile(out,'wb',mtime=0) as gz:
 with tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT) as tf: tf.add(root,arcname='.')`;
    await exec("python", ["-c", code, value.tree, archive], { cwd: process.cwd(), timeout: 30_000 });
    const extract = path.join(value.root, "extract"); await mkdir(extract);
    const result = await shell([bashPath(verifier), "--archive", bashPath(archive), sha(await readFile(archive)), bashPath(extract), `peilv-${value.releaseId}.tar.gz`], true);
    expect(result.stderr).toContain("forbidden member");
  }, 90_000);

  it("rejects a manually injected rotation script", async () => {
    const value = await fixture();
    const injected = path.join(value.tree, "scripts", "rotate-internal-secret.sh"); await mkdir(path.dirname(injected), { recursive: true }); await writeFile(injected, "#!/bin/sh\n");
    const result = await shell([bashPath(verifier), "--tree", bashPath(value.tree)], true);
    expect(result.stderr).toMatch(/forbidden member|forbidden operational path/i);
  }, 90_000);

  it("rejects candidate and installed tree byte tampering", async () => {
    const value = await fixture(); await shell([bashPath(verifier), "--tree", bashPath(value.tree)]);
    await writeFile(path.join(value.tree, "server.js"), "tampered\n");
    const candidate = await shell([bashPath(verifier), "--tree", bashPath(value.tree)], true);
    expect(candidate.stderr).toContain("Release file tree hash mismatch");
  }, 90_000);

  it("closes the extracted administrator bootstrap command without argv secret exposure", async () => {
    const value = await fixture(); const extract = path.join(value.root, "extract"); await mkdir(extract);
    await shell([bashPath(verifier), "--archive", bashPath(value.archive), sha(await readFile(value.archive)), bashPath(extract), `peilv-${value.releaseId}.tar.gz`]);
    const manifest = JSON.parse(await readFile(path.join(extract, "release-manifest.json"), "utf8"));
    expect(manifest.files.find((entry: { path: string }) => entry.path === "scripts/admin-bootstrap.mjs")?.sha256).toBe(sha(await readFile(path.join(extract, "scripts/admin-bootstrap.mjs"))));
    const result = await exec(process.execPath, [path.join(extract, "scripts/admin-bootstrap.mjs"), "forbidden-secret"], { cwd: extract }).then(value => ({ ...value, failed: false }), error => ({ stdout: String(error.stdout), stderr: String(error.stderr), failed: true }));
    expect(result.failed).toBe(true);
    expect(result.stderr).toContain("不接受参数");
    expect(`${result.stdout}${result.stderr}`).not.toContain("forbidden-secret");
    expect(`${result.stdout}${result.stderr}`).not.toContain("MODULE_NOT_FOUND");
  }, 90_000);

  it("rejects missing CLI, package command drift, and CLI hash mismatch", async () => {
    const missing = await fixture(); await rm(path.join(missing.tree, "scripts/admin-bootstrap.mjs"));
    expect((await shell([bashPath(verifier), "--tree", bashPath(missing.tree)], true)).stderr).toContain("missing required file");

    const drift = await fixture(); await writeFile(path.join(drift.tree, "package.json"), `${JSON.stringify({ scripts: { "admin:bootstrap": "node scripts/other.mjs" } })}\n`);
    expect((await shell([bashPath(verifier), "--tree", bashPath(drift.tree)], true)).stderr).toContain("Invalid admin bootstrap package command");

    const mismatch = await fixture(); await writeFile(path.join(mismatch.tree, "scripts/admin-bootstrap.mjs"), "console.log('tampered')\n");
    expect((await shell([bashPath(verifier), "--tree", bashPath(mismatch.tree)], true)).stderr).toContain("Release file tree hash mismatch");
  }, 90_000);
});
