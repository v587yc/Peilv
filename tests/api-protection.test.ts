import { describe, expect, it } from "vitest";
import { getApiProtection, getInternalRoutePurpose, INTERNAL_ROUTE_ALLOWLIST } from "@/lib/api-protection";

describe("API protection policy", () => {
  it.each([
    ["/api/settings", "GET"],
    ["/api/settings", "POST"],
    ["/api/test-llm", "POST"],
    ["/api/feishu/notify", "GET"],
    ["/api/fetch-url", "POST"],
    ["/api/backtest", "GET"],
    ["/api/analysis", "POST"],
    ["/api/analysis/chat", "POST"],
    ["/api/analysis/verify", "PATCH"],
    ["/api/analysis/learn", "POST"],
    ["/api/prediction", "POST"],
    ["/api/prediction", "DELETE"],
    ["/api/data/odds-db", "PATCH"],
    ["/api/memory/chat", "POST"],
    ["/api/memory/entries", "DELETE"],
    ["/api/league-selections", "POST"],
    ["/api/user-focused-leagues", "POST"],
    ["/api/report", "POST"],
  ])("protects %s %s", (pathname, method) => {
    expect(getApiProtection(pathname, method).protected).toBe(true);
  });

  it.each([
    ["/api/prediction", "GET"],
    ["/api/data/odds-db", "GET"],
    ["/api/memory/entries", "GET"],
    ["/api/league-selections", "GET"],
    ["/api/analysis", "GET"],
    ["/api/analysis/verify", "GET"],
    ["/api/analysis/learn", "GET"],
    ["/api/odds", "GET"],
    ["/api/settings", "OPTIONS"],
    ["/api/auth/session", "POST"],
  ])("leaves intended read/login endpoint unprotected: %s %s", (pathname, method) => {
    expect(getApiProtection(pathname, method).protected).toBe(false);
  });

  it("marks the required audited triggers", () => {
    expect(getApiProtection("/api/analysis/verify", "PATCH").auditTrigger).toBe("manual_verification");
    expect(getApiProtection("/api/analysis/learn", "POST").auditTrigger).toBe("learning_trigger");
    expect(getApiProtection("/api/backtest", "POST").auditTrigger).toBeUndefined();
  });

  it("assigns capabilities to protected legacy routes", () => {
    expect(getApiProtection("/api/settings", "GET").capability).toBe("admin:view");
    expect(getApiProtection("/api/settings", "POST").capability).toBe("admin:configure");
    expect(getApiProtection("/api/analysis", "POST").capability).toBe("admin:execute");
    expect(getApiProtection("/api/analysis/verify", "PATCH").capability).toBe("admin:configure");
    expect(getApiProtection("/api/analysis/learn", "POST").capability).toBe("admin:execute");
    expect(getApiProtection("/api/strategy/v1/publish", "POST").capability).toBe("admin:dangerous");
    expect(getApiProtection("/api/prediction", "POST").capability).toBe("admin:configure");
  });

  it("keeps the internal allowlist exact and purpose-bound", () => {
    expect(INTERNAL_ROUTE_ALLOWLIST).toEqual([
      { pathname: "/api/automation/dispatch", method: "POST", purpose: "automation:dispatch" },
      { pathname: "/api/automation/reconcile", method: "POST", purpose: "automation:reconcile" },
      { pathname: "/api/automation/compensate", method: "POST", purpose: "automation:compensate" },
      { pathname: "/api/storage/health", method: "GET", purpose: "storage:health" },
    ]);
    expect(getInternalRoutePurpose("/api/automation/dispatch", "POST")).toBe("automation:dispatch");
    expect(getInternalRoutePurpose("/api/automation/dispatch", "GET")).toBeNull();
    expect(getInternalRoutePurpose("/api/automation/dispatch/extra", "POST")).toBeNull();
    expect(getInternalRoutePurpose("/api/analysis", "POST")).toBeNull();
  });
});
