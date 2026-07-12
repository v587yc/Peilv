export type AuditTrigger = "manual_verification" | "learning_trigger" | "backtest_trigger";

export interface ProtectionRule {
  auditTrigger?: AuditTrigger;
  protected: boolean;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function pathMatches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function getApiProtection(pathname: string, method: string): ProtectionRule {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "OPTIONS") return { protected: false };

  if (
    pathMatches(pathname, "/api/settings") ||
    pathMatches(pathname, "/api/test-llm") ||
    pathMatches(pathname, "/api/feishu/notify") ||
    pathMatches(pathname, "/api/fetch-url")
  ) {
    return { protected: true };
  }

  if (pathMatches(pathname, "/api/backtest")) {
    return {
      protected: true,
      auditTrigger: normalizedMethod === "POST" ? "backtest_trigger" : undefined,
    };
  }

  if (pathname === "/api/analysis/verify" && normalizedMethod === "PATCH") {
    return { protected: true, auditTrigger: "manual_verification" };
  }

  if (pathname === "/api/analysis/learn" && normalizedMethod === "POST") {
    return { protected: true, auditTrigger: "learning_trigger" };
  }

  if (
    (pathname === "/api/analysis" || pathname === "/api/analysis/chat") &&
    normalizedMethod === "POST"
  ) {
    return { protected: true };
  }

  if (
    WRITE_METHODS.has(normalizedMethod) &&
    (
      pathMatches(pathname, "/api/prediction") ||
      pathMatches(pathname, "/api/data/odds-db") ||
      pathMatches(pathname, "/api/memory") ||
      pathMatches(pathname, "/api/league-selections") ||
      pathMatches(pathname, "/api/user-focused-leagues") ||
      pathMatches(pathname, "/api/strategy") ||
      pathMatches(pathname, "/api/report")
    )
  ) {
    return { protected: true };
  }

  return { protected: false };
}
