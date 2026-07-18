import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminSession, readAdminSession } from "@/app/login/auth-client";

afterEach(() => vi.unstubAllGlobals());
describe("admin login client", () => {
  it("sends username and password without a legacy token field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await createAdminSession({ username: "root", password: "StrongPassword123" });
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual({ username: "root", password: "StrongPassword123" });
  });
  it("accepts the explicit logged-out probe without treating it as authenticated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ configured: true, initialized: false, authenticated: false, user: null }), { status: 200 })));
    await expect(readAdminSession()).resolves.toMatchObject({ initialized: false, authenticated: false, user: null });
  });
  it("surfaces probe infrastructure failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: false, user: null, error: "管理员认证暂时不可用" }), { status: 503 })));
    await expect(readAdminSession()).rejects.toThrow("管理员认证暂时不可用");
  });
});
