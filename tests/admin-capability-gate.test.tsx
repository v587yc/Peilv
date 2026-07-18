// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ require: vi.fn(), child: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ cookie: "admin_session=test" })) }));
vi.mock("@/lib/auth/admin-capabilities", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/admin-capabilities")>();
  return { ...actual, requireAdminCapability: mocks.require };
});

import { AdminCapabilityGate } from "@/app/admin/_components/admin-capability-gate";

describe("server administrator capability gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders a polished 403 and never mounts the protected child when denied", async () => {
    mocks.require.mockResolvedValue({ ok: false, status: 403, error: "权限不足" });
    const element = await AdminCapabilityGate({ required: "admin:manage", children: () => { mocks.child(); return <div>protected request component</div>; } });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("没有此页面的访问权限");
    expect(html).toContain("admin:manage");
    expect(html).not.toContain("protected request component");
    expect(mocks.child).not.toHaveBeenCalled();
  });

  it("renders the protected child only after server authorization", async () => {
    mocks.require.mockResolvedValue({ ok: true, principal: { actorId: "admin-1", actorType: "admin", role: "super_admin", capabilities: ["admin:view", "admin:manage"] } });
    const element = await AdminCapabilityGate({ required: "admin:manage", children: () => { mocks.child(); return <div>protected request component</div>; } });
    expect(renderToStaticMarkup(element)).toContain("protected request component");
    expect(mocks.child).toHaveBeenCalledOnce();
  });
});
