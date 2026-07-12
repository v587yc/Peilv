import { NextRequest, NextResponse } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";
import { createAutomationService } from "@/lib/automation/service";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ success: false, error: "内部任务认证失败" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({})) as { maxTasks?: number };
    const maxTasks = Math.max(1, Math.min(Number(body.maxTasks) || 1, 20));
    const service = createAutomationService(request.nextUrl.origin);
    const ensured = await service.engine.ensureDueTasks();
    const processed = await service.engine.runAvailable(maxTasks);
    return NextResponse.json({
      success: true,
      ensured: ensured.map((task) => task.id),
      processed: processed.map((task) => task.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "调度失败";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
