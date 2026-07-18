import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const upsert = vi.hoisted(() => vi.fn());

vi.mock("@/storage/database/supabase-client", () => ({
  getSupabaseClient: () => ({
    from: () => ({
      upsert,
    }),
  }),
}));

vi.mock("@/lib/auth/admin-capabilities", () => ({
  requireAdminCapability: vi.fn(async () => ({
    ok: true,
    principal: { actorId: "admin-test", actorType: "admin", capabilities: ["admin:configure"] },
  })),
}));

vi.mock("@/features/management/route-command", () => ({
  runRouteCommand: async (
    request: NextRequest,
    _principal: unknown,
    _action: string,
    execute: (payload: Record<string, unknown>) => Promise<unknown>,
  ) => {
    try {
      const command = await request.json() as { payload?: Record<string, unknown> };
      return Response.json({ success: true, result: await execute(command.payload || {}) });
    } catch (error) {
      return Response.json({ success: false, error: error instanceof Error ? error.message : "请求失败" }, { status: 400 });
    }
  },
}));

import { PATCH } from "@/app/api/admin/settings/route";

describe("admin settings SSRF policy", () => {
  beforeEach(() => upsert.mockReset());

  it.each([
    "https://127.0.0.1/v1",
    "https://2130706433/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
  ])("rejects unsafe URL before persistence %s", async value => {
    const response = await PATCH(new NextRequest("http://local/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { replacements: { llm_base_url: value } } }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: expect.stringContaining("安全出站策略"),
    }));
    expect(upsert).not.toHaveBeenCalled();
  });
});
