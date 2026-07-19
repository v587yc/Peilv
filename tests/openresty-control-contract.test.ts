import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("1Panel OpenResty host control boundary", () => {
  it("accepts only fixed test or reload actions with verified container identity", async () => {
    const script = await readFile(new URL("../scripts/lib/openresty-control.sh", import.meta.url), "utf8");
    expect(script).toContain('[[ $# == 1 && ( "$1" == test || "$1" == reload ) ]]');
    expect(script).toContain("readonly container_name=1Panel-openresty");
    expect(script).toContain("readonly expected_image=1panel/openresty:1.31.1.1-0-noble");
    expect(script).toContain("com.docker.compose.project");
    expect(script).toContain("com.docker.compose.service");
    expect(script).toContain("/usr/local/openresty/nginx/sbin/nginx");
    expect(script).not.toContain("eval");
  });
});
