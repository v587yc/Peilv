import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const standalone = path.resolve(".next/standalone");
describe("Next standalone runtime dependency closure", () => {
  it.each(["next", "styled-jsx", "react", "react-dom"])("resolves %s from the standalone server dependency scope", name => {
    const requireFromStandalone = createRequire(path.join(standalone, "server.js"));
    let resolved: string;
    try { resolved = requireFromStandalone.resolve(`${name}/package.json`); }
    catch { resolved = requireFromStandalone.resolve(name); }
    expect(path.resolve(resolved).startsWith(`${standalone}${path.sep}`)).toBe(true);
  });
  it("does not rely on the workspace node_modules through links", async () => {
    const materializer = await readFile("scripts/release-materialize.mjs", "utf8");
    expect(materializer).toContain("allowed dependency roots");
    expect(materializer).toContain("Materialized stage contains a link, special file, or hard link");
    expect(await readFile("scripts/create-release.sh", "utf8")).toContain("release-materialize.mjs");
  });
  it("excludes Inspector tooling and Next's build-only shell parser", async () => {
    const build = await readFile("scripts/build.sh", "utf8");
    for (const name of ["react-dev-inspector", "react-dev-utils", "shell-quote"]) {
      expect(build).toContain(`forbidden_dependency in react-dev-inspector react-dev-utils shell-quote`);
      expect(build).toContain("assembled standalone contains forbidden dependency");
      await expect(access(path.join(standalone, "node_modules", name))).rejects.toThrow();
    }
    expect(build).toContain("rm -rf .next/standalone/node_modules/next/dist/compiled/shell-quote");
    await expect(access(path.join(standalone, "node_modules", "next", "dist", "compiled", "shell-quote"))).rejects.toThrow();
  });
});
