import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextFetchEvent, NextRequest } from "next/server";

vi.mock("@/lib/admin-auth", () => ({
  authorizeAdminRequest: vi.fn(async () => ({ ok: false, error: "未登录", status: 401 })),
  isSameOriginMutation: vi.fn(() => true),
}));

vi.mock("@/lib/auth/admin-capabilities", () => ({
  hasAdminCapability: vi.fn(() => false),
  principalForActor: vi.fn(() => ({})),
}));

vi.mock("@/lib/api-protection", () => ({
  getApiProtection: vi.fn(() => ({ protected: false })),
  getLegacyWriteTombstone: vi.fn(() => null),
  getInternalRoutePurpose: vi.fn(() => null),
}));

vi.mock("@/lib/internal-auth", () => ({
  isInternalRequest: vi.fn(() => false),
}));

vi.mock("@/lib/audit-log", () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/storage/database/supabase-client", () => ({
  getSupabaseClient: vi.fn(() => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) })),
}));

import { proxy } from "@/proxy";
import { authorizeAdminRequest } from "@/lib/admin-auth";

function makeEvent(): NextFetchEvent {
  return { waitUntil: () => undefined } as unknown as NextFetchEvent;
}

describe("proxy admin login redirect", () => {
  beforeEach(() => {
    vi.mocked(authorizeAdminRequest).mockResolvedValue({ ok: false, error: "未登录", status: 401 } as never);
    process.env.NODE_ENV = "production";
  });

  it("strips internal :5000 from admin login redirects when forwarded host is public", async () => {
    const request = new NextRequest("http://127.0.0.1:5000/admin", {
      headers: {
        host: "127.0.0.1:5000",
        "x-forwarded-host": "pb.aixid.cc",
        "x-forwarded-proto": "https",
      },
    });
    const response = await proxy(request, makeEvent());
    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBe("https://pb.aixid.cc/login?next=%2Fadmin");
    expect(location).not.toContain(":5000");
  });

  it("does not keep :5000 even if only host header has the upstream port", async () => {
    const request = new NextRequest("http://127.0.0.1:5000/admin/strategies", {
      headers: {
        host: "pb.aixid.cc:5000",
        "x-forwarded-proto": "https",
      },
    });
    const response = await proxy(request, makeEvent());
    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBe("https://pb.aixid.cc/login?next=%2Fadmin%2Fstrategies");
    expect(location).not.toContain(":5000");
  });
});
