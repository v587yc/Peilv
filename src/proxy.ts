import { NextFetchEvent, NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isSameOriginMutation } from "@/lib/admin-auth";
import { hasAdminCapability, principalForActor } from "@/lib/auth/admin-capabilities";
import { getApiProtection, getLegacyWriteTombstone, type AuditTrigger } from "@/lib/api-protection";
import { getInternalRoutePurpose } from "@/lib/api-protection";
import { isInternalRequest } from "@/lib/internal-auth";
import { writeAuditLog } from "@/lib/audit-log";
import { getSupabaseClient } from "@/storage/database/supabase-client";

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json(
    { success: false, error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function nextWithoutForgedActorHeaders(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete("x-authenticated-actor-id");
  headers.delete("x-authenticated-actor-type");
  return NextResponse.next({ request: { headers } });
}

async function auditTrigger(
  request: NextRequest,
  trigger: AuditTrigger,
  actor: { actorId: string; actorType: "admin" | "internal" },
  requestId: string,
): Promise<void> {
  const body = await request.clone().json().catch(() => ({})) as Record<string, unknown>;

  if (trigger === "manual_verification") {
    let oldValue: Record<string, unknown> | null = null;
    if (typeof body.matchId === "string" && typeof body.matchDate === "string") {
      try {
        const { data } = await getSupabaseClient()
          .from("prediction_results")
          .select("manual_is_correct, is_correct, verification_status, handicap_manual_is_correct, handicap_effective_is_correct, handicap_effective_status, total_manual_is_correct, total_effective_is_correct, total_effective_status")
          .eq("match_id", body.matchId)
          .eq("match_date", body.matchDate)
          .maybeSingle();
        oldValue = data || null;
      } catch {
        oldValue = null;
      }
    }
    await writeAuditLog({
      ...actor,
      action: "manual_verification",
      objectType: "prediction_result",
      objectId: body.matchId && body.matchDate ? `${body.matchId}:${body.matchDate}` : null,
      requestId,
      oldValue,
      newValue: { market: body.market, manualIsCorrect: body.isCorrect },
    });
    return;
  }

  if (trigger === "learning_trigger") {
    await writeAuditLog({
      ...actor,
      action: "learning_trigger",
      objectType: "learned_patterns",
      objectId: typeof body.league === "string" ? body.league : "ALL",
      requestId,
      metadata: {
        source: body.source === "backtest" ? "backtest" : "production",
        minSamples: body.minSamples,
      },
    });
    return;
  }

  await writeAuditLog({
    ...actor,
    action: "backtest_trigger",
    objectType: "backtest_job",
    requestId,
    metadata: {
      startDate: body.startDate,
      endDate: body.endDate,
      minConfidence: body.minConfidence,
      maxMatches: body.maxMatches,
    },
  });
}

export async function proxy(request: NextRequest, event: NextFetchEvent): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  const isAdminApi = pathname === "/api/admin" || pathname.startsWith("/api/admin/");
  const isAdminPage = pathname === "/admin" || pathname.startsWith("/admin/");

  // Internal authentication is route-scoped, not an alternate administrator
  // session. A valid internal credential is denied everywhere except the exact
  // method/path allowlist, including otherwise-public compatibility APIs.
  if (pathname.startsWith("/api/") && isInternalRequest(request)) {
    if (!getInternalRoutePurpose(pathname, request.method)) return jsonError("内部任务无权访问此接口", 403);
    return nextWithoutForgedActorHeaders(request);
  }

  if (isAdminApi || isAdminPage) {
    const authorization = await authorizeAdminRequest(request);
    if (!authorization.ok || authorization.actor.actorType !== "admin") {
      if (isAdminApi) {
        const error = authorization.ok ? "需要管理员登录" : authorization.error;
        const status = authorization.ok ? 401 : authorization.status;
        return jsonError(error, status);
      }
      const login = request.nextUrl.clone();
      const isProduction = process.env.NODE_ENV === "production";
      const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
      const requestHost = isProduction ? forwardedHost : request.headers.get("host");
      if (requestHost) login.host = requestHost;
      if (isProduction && forwardedHost) {
        const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
        if (forwardedProto === "http" || forwardedProto === "https") login.protocol = `${forwardedProto}:`;
      }
      login.pathname = "/login";
      login.search = "";
      login.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(login);
    }
    if (isAdminApi && !isSameOriginMutation(request)) return jsonError("跨站请求校验失败", 403);

    const headers = new Headers(request.headers);
    headers.set("x-request-id", crypto.randomUUID());
    headers.set("x-authenticated-actor-id", authorization.actor.actorId);
    headers.set("x-authenticated-actor-type", authorization.actor.actorType);
    return NextResponse.next({ request: { headers } });
  }

  const protection = getApiProtection(pathname, request.method);
  if (!protection.protected) return nextWithoutForgedActorHeaders(request);

  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);

  if (authorization.actor.actorType !== "admin") return jsonError("内部任务无权访问此接口", 403);

  if (protection.capability) {
    const principal = principalForActor(authorization.actor);
    if (!hasAdminCapability(principal, protection.capability)) return jsonError("权限不足", 403);
  }

  if (authorization.actor.actorType === "admin" && !isSameOriginMutation(request)) {
    return jsonError("跨站请求校验失败", 403);
  }

  const tombstone = getLegacyWriteTombstone(pathname, request.method);
  if (tombstone) {
    const principal = principalForActor(authorization.actor);
    if (!hasAdminCapability(principal, tombstone.capability)) return jsonError("权限不足", 403);
    return NextResponse.json(
      { success: false, error: "旧管理写入口已退役，请使用 /api/admin 管理接口", errorCode: "LEGACY_MANAGEMENT_WRITE_GONE" },
      { status: 410, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("x-authenticated-actor-id", authorization.actor.actorId);
  requestHeaders.set("x-authenticated-actor-type", authorization.actor.actorType);

  if (protection.auditTrigger) {
    event.waitUntil(auditTrigger(request, protection.auditTrigger, authorization.actor, requestId));
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/api/:path*", "/admin/:path*"],
};
