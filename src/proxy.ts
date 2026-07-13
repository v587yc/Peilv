import { NextFetchEvent, NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isSameOriginMutation } from "@/lib/admin-auth";
import { authorizeDeploymentRequest, getTrustedDeploymentOrigin, isSameOriginDeploymentMutation, verifyDeploymentCsrfToken } from "@/lib/deployment-auth";
import { getApiProtection, type AuditTrigger } from "@/lib/api-protection";
import { writeAuditLog } from "@/lib/audit-log";
import { getSupabaseClient } from "@/storage/database/supabase-client";

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json(
    { success: false, error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
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

export function proxy(request: NextRequest, event: NextFetchEvent): NextResponse {
  const pathname = request.nextUrl.pathname;
  const isDeploymentApi = pathname === "/api/deployments" || pathname.startsWith("/api/deployments/");
  const isDeploymentPage = pathname === "/deployments" || pathname.startsWith("/deployments/");

  if (isDeploymentApi || isDeploymentPage) {
    const actor = authorizeDeploymentRequest(request);
    if (!actor) {
      if (isDeploymentApi) return jsonError("需要部署控制台登录", 401);
      const login = new URL("/deployment-login", getTrustedDeploymentOrigin(request));
      return NextResponse.redirect(login);
    }
    if (isDeploymentApi && !isSameOriginDeploymentMutation(request)) return jsonError("跨站请求校验失败", 403);
    if (isDeploymentApi && !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
      const action = pathname.split("/").filter(Boolean).at(-1) || "unknown";
      if (!verifyDeploymentCsrfToken(actor, action, request.headers.get("x-csrf-token"))) {
        return jsonError("CSRF 校验失败", 403);
      }
    }
    const headers = new Headers(request.headers);
    headers.set("x-request-id", request.headers.get("x-request-id") || crypto.randomUUID());
    headers.set("x-authenticated-actor-id", actor.actorId);
    headers.set("x-authenticated-actor-type", actor.actorType);
    headers.set("x-authenticated-deployment-username", actor.username);
    return NextResponse.next({ request: { headers } });
  }

  const protection = getApiProtection(pathname, request.method);
  if (!protection.protected) return NextResponse.next();

  const authorization = authorizeAdminRequest(request);
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);

  if (authorization.actor.actorType === "admin" && !isSameOriginMutation(request)) {
    return jsonError("跨站请求校验失败", 403);
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
  matcher: ["/api/:path*", "/deployments/:path*"],
};
