import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("administrator account lifecycle", () => {
  it("uses reversible deactivation instead of physical deletion", async () => {
    const view = await readFile(new URL("../src/app/admin/_components/admin-users-view.tsx", import.meta.url), "utf8");
    const collectionRoute = await readFile(new URL("../src/app/api/admin/users/route.ts", import.meta.url), "utf8");
    const itemRoute = await readFile(new URL("../src/app/api/admin/users/[id]/route.ts", import.meta.url), "utf8");
    expect(view).toContain("停用账号");
    expect(view).toContain("确认重新启用");
    expect(view).toContain("不物理删除管理员");
    expect(view).not.toContain("删除账号");
    expect(collectionRoute).not.toMatch(/export\s+async\s+function\s+DELETE/);
    expect(itemRoute).not.toMatch(/export\s+async\s+function\s+DELETE/);
  });
});
