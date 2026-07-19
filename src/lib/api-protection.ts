export type AuditTrigger = "manual_verification" | "learning_trigger" | "backtest_trigger";

export interface ProtectionRule {
  auditTrigger?: AuditTrigger;
  capability?: AdminCapability;
  protected: boolean;
}

export const INTERNAL_ROUTE_PURPOSES = [
  "automation:dispatch",
  "automation:reconcile",
  "automation:compensate",
  "storage:health",
] as const;
export type InternalRoutePurpose = (typeof INTERNAL_ROUTE_PURPOSES)[number];

type LegacyWriteTombstone = Readonly<{ pathname: string | RegExp; method: "POST" | "PUT" | "PATCH" | "DELETE"; capability: AdminCapability }>;
export const LEGACY_WRITE_TOMBSTONES: readonly LegacyWriteTombstone[] = [
  { pathname: "/api/settings", method: "POST", capability: "admin:configure" },
  { pathname: "/api/strategy", method: "POST", capability: "admin:configure" },
  { pathname: /^\/api\/strategy\/[^/]+\/(publish|rollback)$/, method: "POST", capability: "admin:dangerous" },
  { pathname: "/api/backtest", method: "POST", capability: "admin:execute" },
  { pathname: "/api/backtest", method: "DELETE", capability: "admin:execute" },
] as const;

export function getLegacyWriteTombstone(pathname: string, method: string): LegacyWriteTombstone | null {
  const normalized = method.toUpperCase();
  return LEGACY_WRITE_TOMBSTONES.find(rule => rule.method === normalized && (typeof rule.pathname === "string" ? rule.pathname === pathname : rule.pathname.test(pathname))) || null;
}

type InternalRouteRule = Readonly<{
  pathname: string;
  method: string;
  purpose: InternalRoutePurpose;
}>;

/** Internal actors have no implicit admin capability. Keep this list exact. */
export const INTERNAL_ROUTE_ALLOWLIST: readonly InternalRouteRule[] = [
  { pathname: "/api/automation/dispatch", method: "POST", purpose: "automation:dispatch" },
  { pathname: "/api/automation/reconcile", method: "POST", purpose: "automation:reconcile" },
  { pathname: "/api/automation/compensate", method: "POST", purpose: "automation:compensate" },
  { pathname: "/api/storage/health", method: "GET", purpose: "storage:health" },
] as const;

export function getInternalRoutePurpose(pathname: string, method: string): InternalRoutePurpose | null {
  const normalizedMethod = method.toUpperCase();
  return INTERNAL_ROUTE_ALLOWLIST.find(rule => rule.pathname === pathname && rule.method === normalizedMethod)?.purpose || null;
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
    return { protected: true, capability: normalizedMethod === "GET" ? "admin:view" : "admin:configure" };
  }

  if (pathMatches(pathname, "/api/backtest")) {
    return {
      protected: true,
      capability: normalizedMethod === "GET" ? "admin:view" : "admin:execute",
      auditTrigger: getLegacyWriteTombstone(pathname, normalizedMethod) ? undefined : normalizedMethod === "POST" ? "backtest_trigger" : undefined,
    };
  }

  if (pathname === "/api/analysis/verify" && normalizedMethod === "PATCH") {
    return { protected: true, capability: "admin:configure", auditTrigger: "manual_verification" };
  }

  if (pathname === "/api/analysis/learn" && normalizedMethod === "POST") {
    return { protected: true, capability: "admin:execute", auditTrigger: "learning_trigger" };
  }

  if (
    (pathname === "/api/analysis" || pathname === "/api/analysis/chat") &&
    normalizedMethod === "POST"
  ) {
    return { protected: true, capability: "admin:execute" };
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
    const dangerousStrategyAction = pathMatches(pathname, "/api/strategy") && (pathname.endsWith("/publish") || pathname.endsWith("/rollback"));
    return { protected: true, capability: dangerousStrategyAction ? "admin:dangerous" : "admin:configure" };
  }

  return { protected: false };
}
import type { AdminCapability } from "@/lib/auth/admin-capabilities";
