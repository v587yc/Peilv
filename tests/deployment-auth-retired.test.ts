import { describe, expect, it } from "vitest";
import { DELETE, GET, POST } from "@/app/api/deployment-auth/session/route";

describe("retired deployment authentication API", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
    ["DELETE", DELETE],
  ])("rejects legacy %s authentication without issuing a session", async (_method, handler) => {
    const response = handler();
    expect(response.status).toBe(410);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      loginUrl: "/login?next=/admin/deployments",
    });
  });
});
