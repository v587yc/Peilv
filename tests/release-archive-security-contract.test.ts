import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("release archive security contract", () => {
  it("validates required release files and directories with the correct node type", async () => {
    const script = await read("scripts/create-release.sh");
    expect(script).toContain("required_files=(");
    expect(script).toContain("required_dirs=(");
    expect(script).toMatch(/for path in "\$\{required_files\[@\]\}"; do[\s\S]{0,200}\[\[ ! -f "\$path"/);
    expect(script).toMatch(/for path in "\$\{required_dirs\[@\]\}"; do[\s\S]{0,250}\[\[ ! -d "\$path"/);
    expect(script).toMatch(/required_dirs[\s\S]{0,500}find "\$path" -type f -print -quit/);
  });

  it("copies the caller archive once and verifies plus extracts only that private copy", async () => {
    const deploy = await read("scripts/deploy-production.sh");
    expect(deploy).toContain('private_archive="$verified_incoming_dir/$request_id.tar.gz"');
    expect(deploy).toContain('node "$private_copy_helper" "$archive" "$private_archive"');
    const copy = await read("scripts/private-copy.mjs");
    expect(copy).toContain("O_RDONLY | fs.constants.O_NOFOLLOW");
    expect(copy).toContain("O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW");
    expect(copy).toContain('"dev", "ino", "size", "ctimeMs", "mtimeMs", "mode", "nlink"');
    expect(deploy).toMatch(/verify-release\.sh --archive "\$private_archive" "\$expected_sha" "\$release_dir"/);
    expect(deploy).not.toMatch(/verify-release\.sh --archive "\$archive"/);
    const verify = await read("scripts/verify-release.sh");
    expect(verify).not.toContain("tar -tvzf");
    expect(verify).not.toContain("tar -xzf");
    expect(verify).toContain('verify-extract "$(native_path "$archive")"');
  });

  it("rejects normalized duplicates, file-directory conflicts and all non-regular member types", async () => {
    const script = await read("scripts/release-archive.py");
    expect(script).toContain("Duplicate normalized archive path");
    expect(script).toContain("Archive file/directory conflict");
    expect(script).toContain("member.pax_headers");
    expect(script).toContain("Archive contains a link or special file");
  });

  it("binds candidate staging and the formal release to the same manifest file tree", async () => {
    const deploy = await read("scripts/deploy-production.sh");
    const formalBefore = deploy.indexOf('verify-release.sh --tree "$release_dir" --root-owned');
    const candidate = deploy.indexOf('"$release_verifier" --tree "$candidate_stage"');
    const formalAfter = deploy.indexOf('verify-release.sh --tree "$release_dir" --root-owned', formalBefore + 1);
    const readiness = deploy.indexOf("check_candidate_application 5001");
    expect(formalBefore).toBeGreaterThan(-1);
    expect(candidate).toBeGreaterThan(formalBefore);
    expect(readiness).toBeGreaterThan(candidate);
    expect(formalAfter).toBeGreaterThan(readiness);
    const rollback = await read("scripts/rollback-production.sh");
    expect(rollback).toContain('verify-release.sh --tree "$target" --root-owned');
    expect(rollback).toContain('verify-release.sh --tree "$candidate_stage"');
    expect(rollback.indexOf('verify-release.sh --tree "$target" --root-owned', rollback.indexOf("check_candidate_application 5001"))).toBeGreaterThan(-1);
  });

  it("preflight measures a private archive copy and binds the result to the requested SHA", async () => {
    const script = await read("scripts/production-preflight.sh");
    expect(script).toContain('private_archive="$verified_incoming_dir/preflight-$request_id.tar.gz"');
    expect(script).toContain('measured_archive_sha="$(node "$private_copy_helper"');
    expect(script).toContain('[[ "$measured_archive_sha" != "$archive_sha" ]]');
    expect(script).toMatch(/verify-release\.sh --archive "\$private_archive" "\$measured_archive_sha"/);
    expect(script).toContain('ARCHIVE_SHA="$measured_archive_sha"');
  });

  it("shares strict resource and deny limits between creation and verification", async () => {
    const create = await read("scripts/create-release.sh");
    const materialize = await read("scripts/release-materialize.mjs");
    const archive = await read("scripts/release-archive.py");
    expect(create).toContain("release-materialize.mjs");
    expect(create).toContain('"$archive_tool_native" create');
    expect(materialize).toContain("release-limits.json");
    expect(archive).toContain("release-limits.json");
    for (const token of ["maxArchiveBytes", "maxMembers", "maxFileBytes", "maxTotalBytes", "maxPathBytes", "maxPathDepth", "maxCompressionRatio"]) {
      expect(await read("scripts/release-limits.json")).toContain(token);
    }
  });
});
