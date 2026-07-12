import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/auth/session/route";

const originalToken = process.env.ADMIN_API_TOKEN;

beforeEach(() => {
  process.env.ADMIN_API_TOKEN = "route-test-token";
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = originalToken;
});

describe("admin session API", () => {
  it("returns 503 instead of failing open when unconfigured", async () => {
    delete process.env.ADMIN_API_TOKEN;
    const response = await POST(new NextRequest("https://app.invalid/api/auth/session", {
      method: "POST",
      headers: { origin: "https://app.invalid", "content-type": "application/json" },
      body: JSON.stringify({ token: "anything" }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it("rejects invalid credentials without setting a cookie", async () => {
    const response = await POST(new NextRequest("https://app.invalid/api/auth/session", {
      method: "POST",
      headers: { origin: "https://app.invalid", "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("sets an HttpOnly strict session cookie and authenticates it", async () => {
    const loginResponse = await POST(new NextRequest("https://app.invalid/api/auth/session", {
      method: "POST",
      headers: { origin: "https://app.invalid", "content-type": "application/json" },
      body: JSON.stringify({ token: "route-test-token" }),
    }));
    const setCookie = loginResponse.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";")[0];

    expect(loginResponse.status).toBe(200);
    expect(setCookie).toContain("admin_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=strict");
    expect(setCookie.toLowerCase()).toContain("secure");
    expect(setCookie).not.toContain("route-test-token");

    const statusResponse = await GET(new NextRequest("https://app.invalid/api/auth/session", {
      headers: { cookie },
    }));
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ configured: true, authenticated: true });
  });

  it("allows the session cookie over an HTTP reverse proxy", async () => {
    const response = await POST(new NextRequest("http://app.invalid/api/auth/session", {
      method: "POST",
      headers: {
        origin: "http://app.invalid",
        "content-type": "application/json",
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({ token: "route-test-token" }),
    }));
    const setCookie = response.headers.get("set-cookie") || "";

    expect(response.status).toBe(200);
    expect(setCookie).toContain("admin_session=");
    expect(setCookie.toLowerCase()).not.toContain("secure");
  });

  it("uses a secure cookie when HTTPS terminates at the reverse proxy", async () => {
    const response = await POST(new NextRequest("http://app.internal/api/auth/session", {
      method: "POST",
      headers: {
        origin: "https://app.invalid",
        host: "app.invalid",
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ token: "route-test-token" }),
    }));
    const setCookie = response.headers.get("set-cookie") || "";

    expect(response.status).toBe(200);
    expect(setCookie.toLowerCase()).toContain("secure");
  });

  it("rejects cross-origin login attempts", async () => {
    const response = await POST(new NextRequest("https://app.invalid/api/auth/session", {
      method: "POST",
      headers: { origin: "https://evil.invalid", "content-type": "application/json" },
      body: JSON.stringify({ token: "route-test-token" }),
    }));

    expect(response.status).toBe(403);
  });
});
