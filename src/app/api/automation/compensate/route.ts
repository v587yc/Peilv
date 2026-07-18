import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isSameOriginMutation } from "@/lib/admin-auth";
import { hasAdminCapability, principalForActor } from "@/lib/auth/admin-capabilities";
import { createAutomationService } from "@/lib/automation/service";
import { getInternalAppBaseUrl } from "@/lib/internal-app-base-url";
import { AUTOMATION_TASK_TYPES, type AutomationTaskType } from "@/lib/automation/types";
import { isAuthorizedInternalRoute, isInternalRequest } from "@/lib/internal-auth";

export const maxDuration = 300;

function parseTypes(value: unknown): AutomationTaskType[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((type) => !AUTOMATION_TASK_TYPES.includes(type as AutomationTaskType))) {
    throw new Error("包含不支持的任务类型");
  }
  return value as AutomationTaskType[];
}

export async function POST(request: NextRequest) {
  if (isInternalRequest(request)) {
    if (!isAuthorizedInternalRoute(request, "automation:compensate")) {
      return NextResponse.json({ success: false, error: "内部任务无权访问此接口" }, { status: 403 });
    }
  }
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) {
    return NextResponse.json({ success: false, error: authorization.error }, { status: authorization.status });
  }
  if (authorization.actor.actorType === "admin" && !isSameOriginMutation(request)) {
    return NextResponse.json({ success: false, error: "跨站请求校验失败" }, { status: 403 });
  }
  if (authorization.actor.actorType === "admin" && !hasAdminCapability(principalForActor(authorization.actor), "admin:execute")) {
    return NextResponse.json({ success: false, error: "权限不足" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({})) as { types?: unknown; maxTasks?: number };
    const types = parseTypes(body.types);
    const maxTasks = Math.max(1, Math.min(Number(body.maxTasks) || 1, 20));
    const service = createAutomationService(getInternalAppBaseUrl());
    const ensured = await service.engine.compensate(new Date(), types);
    const processed = await service.engine.runAvailable(maxTasks);
    return NextResponse.json({
      success: true,
      ensured: ensured.map((task) => task.id),
      processed: processed.map((task) => task.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务补偿失败";
    const status = message.includes("12:02") || message.includes("任务类型") ? 400 : 500;
    if (status === 500) console.error("[Automation] Compensation failed:", error);
    return NextResponse.json({ success: false, error: status === 400 ? message : "任务补偿失败" }, { status });
  }
}
