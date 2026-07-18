import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const audit = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/auth/admin-capabilities", () => ({
  requireAdminCapability: () => ({
    ok: true,
    principal: { actorId: "admin-1", actorType: "admin", capabilities: ["admin:dangerous"] },
  }),
}));
vi.mock("@/lib/release-control/audit", () => ({ auditDeploymentRejection: audit }));

import { POST } from "@/app/api/admin/deployments/deploy/route";

describe("deployment rejected command audit", () => {
  beforeEach(() => audit.mockReset().mockResolvedValue(true));

  function invalidDeployRequest() {
    return new NextRequest("http://local/api/admin/deployments/deploy", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "00000000-0000-4000-8000-000000000001" },
      body: JSON.stringify({
        preflightRunId: 10,
        releaseId: "r10-a1-aaaaaaaaaaaa",
        confirmation: "r11-a1-bbbbbbbbbbbb",
        reason: "接口审计测试",
        idempotencyKey: "deploy-test-key",
      }),
    });
  }

  it("persists a safe rejected audit for invalid confirmation", async () => {
    const response = await POST(invalidDeployRequest());
    expect(response.status).toBe(400);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "deployment.deploy",
      requestId: "00000000-0000-4000-8000-000000000001",
      error: "必须输入完整 release ID 确认部署",
    }));
  });

  it("fails closed when rejected-command audit cannot be persisted", async () => {
    audit.mockResolvedValueOnce(false);
    const response = await POST(invalidDeployRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false, error: "审计记录写入失败" });
  });
});
