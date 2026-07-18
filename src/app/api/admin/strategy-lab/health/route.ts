import { NextResponse } from "next/server";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { requestIdFor } from "@/lib/api/safe-error-response";
import { checkStrategyLabReadiness } from "@/features/strategy-lab/production-readiness";
import { getStrategyLabServerState } from "@/features/strategy-lab/server";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const requestId = requestIdFor(request);
  const authorization = await requireAdminCapability(request, "admin:view");
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, status: "unavailable", errorCode: authorization.status === 401 ? "ADMIN_AUTH_REQUIRED" : authorization.status === 403 ? "ADMIN_PERMISSION_DENIED" : "ADMIN_AUTH_UNAVAILABLE", requestId },
      { status: authorization.status, headers: { ...headers, "x-request-id": requestId } },
    );
  }
  const readiness = await checkStrategyLabReadiness(getStrategyLabServerState());
  return NextResponse.json(
    { success: readiness.status === "ready", ...readiness, requestId },
    { status: readiness.status === "ready" ? 200 : 503, headers: { ...headers, "x-request-id": requestId } },
  );
}
