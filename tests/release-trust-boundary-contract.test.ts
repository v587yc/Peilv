import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
const read = (path: string) => readFile(path, "utf8");
const exact = ["verify-release.sh", "release-archive.py", "release-limits.json", "private-copy.mjs", "candidate-stage.sh", "candidate-lifecycle.sh", "deployment-budget.sh", "openresty-control"];

describe("release operations trust boundary", () => {
  it("keeps operational tooling out of application releases", async () => {
    for (const name of ["scripts/create-release.sh", "scripts/verify-release.sh"]) {
      const source = await read(name);
      for (const forbidden of ["rotate-internal-secret.sh", "deploy-production.sh", "rollback-production.sh", "production-preflight.sh", "reconcile-automation.sh", "dispatch-automation.sh", "start.sh", "release-materialize.mjs", "release-archive.py", "private-copy.mjs", "scripts/lib"]) expect(source, name).toContain(forbidden);
      expect(source, name).not.toMatch(/cp[^\n]*rotate-internal-secret\.sh/);
    }
  });
  it.each(["scripts/deploy-production.sh", "scripts/production-preflight.sh", "scripts/rollback-production.sh"])("delegates verifier validation to the shared host helper in %s", async name => {
    expect(await read(name)).toContain('"$trusted_verifier_helper" "$trusted_verifier_sha_file" /usr/local/libexec/peilv');
  });
  it("defines the exact eight-file set once", async () => {
    const helper = await read("scripts/lib/trusted-release-verifier.sh");
    for (const file of exact) expect(helper).toContain(file);
    expect(helper).toContain('${#seen[@]} == 8');
  });
});
