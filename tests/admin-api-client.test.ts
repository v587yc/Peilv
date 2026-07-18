import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiError, adminApiRequest } from "@/app/admin/_components/admin-api-client";

describe("adminApiRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a successful JSON payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, value: 7 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(adminApiRequest<{ success: boolean; value: number }>("/api/admin/overview")).resolves.toEqual({ success: true, value: 7 });
  });

  it("preserves the server error and response payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "数据已变化", user: { id: "u-1" } }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })));

    const error = await adminApiRequest<{ error?: string; user?: { id: string } }>("/api/admin/users/u-1").catch(cause => cause);
    expect(error).toBeInstanceOf(AdminApiError);
    expect(error).toMatchObject({ message: "数据已变化", status: 409, data: { user: { id: "u-1" } } });
  });

  it("turns an HTML gateway response into a readable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })));

    await expect(adminApiRequest("/api/admin/overview")).rejects.toMatchObject({
      message: "后台服务响应异常（HTTP 502）",
      status: 502,
    });
  });

  it("reports an expired session as an authentication error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "未登录" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })));

    await expect(adminApiRequest("/api/admin/overview")).rejects.toMatchObject({
      message: "登录状态已失效，正在返回登录页",
      status: 401,
    });
  });

  it("redirects an HTML 401 before reporting a payload format error", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/admin/backtests", search: "?tab=jobs", replace } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Login</html>", {
      status: 401,
      headers: { "content-type": "text/html" },
    })));

    await expect(adminApiRequest("/api/admin/backtests")).rejects.toMatchObject({
      message: "登录状态已失效，正在返回登录页",
      status: 401,
    });
    expect(replace).toHaveBeenCalledWith("/login?next=%2Fadmin%2Fbacktests%3Ftab%3Djobs");
  });

  it.each([404, 501])("preserves HTTP %s for feature-level degradation", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "能力未启用" }), {
      status,
      headers: { "content-type": "application/json" },
    })));
    await expect(adminApiRequest("/api/admin/optional")).rejects.toMatchObject({ status, message: "能力未启用" });
  });
});
