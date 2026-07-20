import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];
let guardSource = "";
let workflow = "";

beforeAll(async () => {
  const source = await readFile(new URL("../scripts/production-preflight.sh", import.meta.url), "utf8");
  guardSource = source.match(/# BEGIN PREFLIGHT_UPLOAD_GUARD\r?\n([\s\S]*?)\r?\n# END PREFLIGHT_UPLOAD_GUARD/)?.[1] ?? "";
  workflow = await readFile(new URL("../.github/workflows/production-preflight.yml", import.meta.url), "utf8");
  expect(guardSource).not.toBe("");
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type Fixture = { owner?: string; mode?: string; nlink?: string; size?: string; device?: string; kind?: "file" | "symlink" | "directory"; requestId?: string; pathRequestId?: string };

async function runFixture(fixture: Fixture = {}, termination: "success" | "failure" | "HUP" | "INT" | "TERM" = "success") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "preflight-upload-"));
  temporaryDirectories.push(directory);
  const harness = path.join(directory, "harness.sh");
  const requestId = fixture.requestId ?? "00000000-0000-4000-8000-000000000001";
  const pathRequestId = fixture.pathRequestId ?? requestId;
  const archive = `/tmp/peilv-preflight-${pathRequestId}.tar.gz`;
  await writeFile(harness, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${guardSource}\nPEILV_PREFLIGHT_ARCHIVE_MAX_BYTES=1073741824\nPEILV_PREFLIGHT_UPLOAD=\"\"\npreflight_upload_cleanup(){ [[ -z \"\${PEILV_PREFLIGHT_UPLOAD:-}\" ]] || rm -f -- \"$PEILV_PREFLIGHT_UPLOAD\"; }\nstat(){ local fmt= target=; while (($#)); do if [[ \"$1\" == -c ]]; then fmt=\"$2\"; shift 2; elif [[ \"$1\" == -- ]]; then shift; else target=\"$1\"; shift; fi; done; if [[ \"$target\" == /tmp ]]; then printf '7\\n'; else printf '%s\\n' \"\${FIXTURE_STAT}\"; fi; }\ntrap preflight_upload_cleanup EXIT\ntrap 'preflight_upload_cleanup; exit 129' HUP\ntrap 'preflight_upload_cleanup; exit 130' INT\ntrap 'preflight_upload_cleanup; exit 143' TERM\narchive=\"$1\"; kind=\"$2\"; termination=\"$3\"\nrm -rf -- \"$archive\"\ncase \"$kind\" in file) printf x >\"$archive\";; symlink) ln -s /dev/null \"$archive\";; directory) mkdir \"$archive\";; esac\npreflight_upload_validate \"$REQUEST_ID\" \"$archive\"\ncase \"$termination\" in success) :;; failure) false;; *) kill -s \"$termination\" $$;; esac\n`, { mode: 0o755 });
  const result = await exec("bash", [harness, archive, fixture.kind ?? "file", termination], {
    env: { ...process.env, REQUEST_ID: requestId, FIXTURE_STAT: `${fixture.kind === "directory" ? "directory" : "regular file"}|${fixture.owner ?? "peilv-audit"}|${fixture.mode ?? "600"}|${fixture.nlink ?? "1"}|${fixture.size ?? "1"}|${fixture.device ?? "7"}` },
  }).then(value => ({ status: 0, ...value }), error => ({ status: Number(error.code), stdout: String(error.stdout), stderr: String(error.stderr) }));
  const residue = await exec("bash", ["-c", "[[ ! -e \"$1\" && ! -L \"$1\" ]]", "bash", archive]).then(() => false, () => true);
  return { ...result, residue };
}

describe("production preflight upload guard dynamic fixtures", () => {
  it("accepts the canonical safe upload and removes it on success", async () => {
    const result = await runFixture();
    expect(result.status).toBe(0);
    expect(result.residue).toBe(false);
  });

  it.each([
    ["owner", { owner: "root" }],
    ["mode", { mode: "622" }],
    ["symlink", { kind: "symlink" as const }],
    ["hardlink", { nlink: "2" }],
    ["oversize", { size: "1073741825" }],
    ["empty", { size: "0" }],
    ["device", { device: "8" }],
    ["wrong request", { pathRequestId: "00000000-0000-4000-8000-000000000002" }],
  ])("rejects unsafe %s fixture without residue", async (_name, fixture) => {
    const result = await runFixture(fixture);
    expect(result.status).not.toBe(0);
    expect(result.residue).toBe(false);
  });

  it.each(["failure", "HUP", "INT", "TERM"] as const)("removes the upload on %s", async termination => {
    const result = await runFixture({}, termination);
    expect(result.status).not.toBe(0);
    expect(result.residue).toBe(false);
  });
});

describe("production preflight staging static contracts", () => {
  it("keeps restricted SSH fixture semantics and narrowed sudo contracts without storing a credential fixture", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "preflight-authorized-keys-"));
    temporaryDirectories.push(directory);
    const authorizedKeysPath = path.join(directory, "authorized_keys");
    await writeFile(authorizedKeysPath, "# generated non-sensitive test fixture\n# restrict disables forwarding, PTY, user rc and X11\nrestrict ssh-ed25519 TEST_PUBLIC_KEY preflight-test\n");
    const [authorizedKeys, sudoers, control] = await Promise.all([
      readFile(authorizedKeysPath, "utf8"),
      readFile(new URL("../infra/deploy/peilv-sudoers", import.meta.url), "utf8"),
      readFile(new URL("../infra/deploy/peilv-control", import.meta.url), "utf8"),
    ]);
    expect(authorizedKeys).toMatch(/^#.*\n#.*\nrestrict ssh-ed25519 TEST_PUBLIC_KEY /);
    expect(authorizedKeys).not.toMatch(/(?:^|,)(?:port-forwarding|agent-forwarding|x11-forwarding|pty|user-rc)(?:,|\s)/m);
    expect(sudoers).toContain("peilv-audit ALL=(root) NOPASSWD: /usr/local/sbin/peilv-control preflight-v3 *");
    expect(sudoers).not.toMatch(/NOPASSWD:\s*(?:ALL|\/usr\/local\/sbin\/peilv-control\s+\*)/);
    expect(control).toContain("peilv-audit:preflight-v3:11)");
    expect(control).toContain("peilv-audit:preflight-v3:12)");
  });

  it("uses no-clobber publication, bounded capacity, structured transfer errors, and secondary cleanup", async () => {
    expect(workflow).toContain("non-disruptive transient production staging");
    expect(workflow).toContain("available >= bytes + 67108864");
    expect(workflow).toContain('ln -- "$upload" "$archive"');
    expect(workflow).not.toContain('scp -i ~/.ssh/audit_key -P "$PROD_PORT" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes "$archive" "$PROD_USER@$PROD_HOST:$remote_archive"');
    expect(workflow.match(/code=SSH_TRANSFER_FAILED/g)?.length).toBeGreaterThanOrEqual(3);
    expect(workflow).toContain("cleanup_remote_upload");
    expect(workflow).toContain("trap - EXIT HUP INT TERM");
    expect(workflow).toContain("Secondary cleanup of transient production staging");
    expect(workflow).toContain("if: always() && steps.ssh-configuration.outcome == 'success'");
    expect(workflow).toContain('printf \'%s\\n\' "$remote_status" > "$RUNNER_TEMP/peilv-preflight-$REQUEST_ID.exit-status"');
    expect(workflow.match(/<<'CLEANUP'/g)?.length).toBe(2);
    expect(workflow.indexOf("remote_archive_published=1")).toBeGreaterThan(workflow.indexOf('ln -- "$upload" "$archive"'));
  });

  it("validates the exact audit-owned upload before publication and after no-clobber transfer", () => {
    expect(workflow).toContain('bash -s -- "$REQUEST_ID" "$remote_upload" "$remote_archive" "$archive_bytes"');
    expect(workflow).toContain("stat -c '%F|%U|%a|%h|%s|%d' -- \"$upload\"");
    expect(workflow).toContain('"$owner" == peilv-audit');
    expect(workflow).toContain('"$nlink" == 1 && "$size" == "$bytes"');
    expect(workflow).toContain('"$device" == "$(stat -c \'%d\' -- /tmp)"');
    expect(workflow).toContain("stat -c '%F|%U|%a|%h|%s|%d' -- \"$archive\"");
  });

  it("binds the validated external manifest digest into the remote preflight identity", async () => {
    const script = await readFile(new URL("../scripts/production-preflight.sh", import.meta.url), "utf8");
    expect(workflow).toContain('echo "EXTERNAL_MANIFEST_SHA=$(sha256sum "$external"');
    expect(workflow).toContain('"$MIGRATIONS" "$EXTERNAL_MANIFEST_SHA" "$remote_archive"');
    expect(workflow).toContain('peilv-control preflight-v3 "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}"');
    expect(script).toContain('external_manifest_sha="${9:?$usage}"');
    expect(script).toContain('[[ ! "$external_manifest_sha" =~ ^[0-9a-f]{64}$ ]]');
    expect(script).toContain('EXTERNAL_MANIFEST_SHA="$external_manifest_sha"');
    expect(script).not.toContain('sha256sum "$external_manifest"');
  });

  it("dynamically refuses duplicate request publication without replacing or removing it", async () => {
    const publish = workflow.match(/<<'PUBLISH'[^\n]*\r?\n([\s\S]*?)\r?\n {10}PUBLISH/)?.[1].replace(/^ {10}/gm, "") ?? "";
    const requestId = "00000000-0000-4000-8000-0000000000a1";
    const upload = `/tmp/.peilv-preflight-${requestId}.upload-fixture`;
    const archive = `/tmp/peilv-preflight-${requestId}.tar.gz`;
    await exec("bash", ["-c", "printf new >\"$1\"; printf existing >\"$2\"", "bash", upload, archive]);
    const result = await exec("bash", ["-c", publish, "bash", requestId, upload, archive, "3"]).then(() => 0, error => Number(error.code));
    expect(result).not.toBe(0);
    expect((await exec("bash", ["-c", "cat \"$1\"", "bash", archive])).stdout).toBe("existing");
    await expect(exec("bash", ["-c", "test ! -e \"$1\"", "bash", upload])).resolves.toBeDefined();
    const cleanup = workflow.match(/<<'CLEANUP'[^\n]*\r?\n([\s\S]*?)\r?\n {10}CLEANUP/)?.[1].replace(/^ {10}/gm, "") ?? "";
    await exec("bash", ["-c", cleanup, "bash", requestId, upload, archive, "0"]);
    expect((await exec("bash", ["-c", "cat \"$1\"", "bash", archive])).stdout).toBe("existing");
    await exec("bash", ["-c", "rm -f -- \"$1\"", "bash", archive]);
  });

  it("dynamically performs best-effort cleanup after remote failure without masking status", async () => {
    const cleanup = workflow.match(/<<'CLEANUP'[^\n]*\r?\n([\s\S]*?)\r?\n {10}CLEANUP/)?.[1].replace(/^ {10}/gm, "") ?? "";
    const requestId = "00000000-0000-4000-8000-0000000000a2";
    const upload = `/tmp/.peilv-preflight-${requestId}.upload-fixture`;
    const archive = `/tmp/peilv-preflight-${requestId}.tar.gz`;
    await exec("bash", ["-c", "printf partial >\"$1\"; printf published >\"$2\"", "bash", upload, archive]);
    const status = 73;
    await exec("bash", ["-c", `${cleanup}\nexit "$5"`, "bash", requestId, upload, archive, "1", String(status)]).catch(error => expect(Number(error.code)).toBe(status));
    await expect(exec("bash", ["-c", "test ! -e \"$1\" && test ! -e \"$2\"", "bash", upload, archive])).resolves.toBeDefined();
  });

  it("cleans uploaded, private archive/tree, and probe objects and rejects duplicate requests", async () => {
    const script = await readFile(new URL("../scripts/production-preflight.sh", import.meta.url), "utf8");
    expect(script).toContain("preflight_upload_cleanup");
    expect(script).toContain('register_temp_file "$private_archive"');
    expect(script).toContain('register_temp_file "$verified_tree"');
    expect(script).toContain('register_temp_file "$probe_runtime"');
    const control = await readFile(new URL("../infra/deploy/peilv-control", import.meta.url), "utf8");
    expect(control).toContain('acquire_request_lock "$8"');
    expect(control).toContain("flock -n 7");
    expect(script.match(/preflight_upload_validate "\$request_id" "\$uploaded_archive"/g)).toHaveLength(2);
    expect(script.indexOf('preflight_upload_validate "$request_id" "$uploaded_archive"')).toBeLessThan(script.indexOf('measured_archive_sha="$(node "$private_copy_helper"'));
    expect(script.lastIndexOf('preflight_upload_validate "$request_id" "$uploaded_archive"')).toBeGreaterThan(script.indexOf('measured_archive_sha="$(node "$private_copy_helper"'));
  });
});
