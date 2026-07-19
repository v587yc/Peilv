import { describe, expect, it } from "vitest";
import { ROLE_CAPABILITIES, type AdminCapability } from "@/lib/auth/admin-capabilities";
import type { AdminRole } from "@/lib/auth/admin-accounts";

const matrix: Array<{ endpoint: string; capability: AdminCapability; allowed: AdminRole[] }> = [
  { endpoint: "GET /api/admin/overview", capability: "admin:view", allowed: ["super_admin", "operator", "auditor"] },
  { endpoint: "GET /api/admin/audit", capability: "admin:view", allowed: ["super_admin", "operator", "auditor"] },
  { endpoint: "PATCH /api/admin/settings", capability: "admin:configure", allowed: ["super_admin", "operator"] },
  { endpoint: "POST /api/admin/automation", capability: "admin:execute", allowed: ["super_admin", "operator"] },
  { endpoint: "POST /api/admin/backtests", capability: "admin:execute", allowed: ["super_admin", "operator"] },
  { endpoint: "POST /api/admin/deployments/deploy", capability: "admin:dangerous", allowed: ["super_admin"] },
  { endpoint: "PATCH /api/admin/strategies", capability: "admin:dangerous", allowed: ["super_admin"] },
  { endpoint: "POST /api/admin/users", capability: "admin:manage", allowed: ["super_admin"] },
  { endpoint: "PATCH /api/admin/users/:id", capability: "admin:manage", allowed: ["super_admin"] },
];

describe("administrator API role matrix", () => {
  it.each(matrix)("enforces $endpoint as $capability", ({ capability, allowed }) => {
    for (const role of ["super_admin", "operator", "auditor"] as const) {
      expect(ROLE_CAPABILITIES[role].includes(capability), role).toBe(allowed.includes(role));
    }
  });
});
