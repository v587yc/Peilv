import { describe, expect, it } from "vitest";
import { getApiProtection } from "@/lib/api-protection";

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
    expect(getApiProtection("/api/backtest", "POST").auditTrigger).toBe("backtest_trigger");
  });
});
