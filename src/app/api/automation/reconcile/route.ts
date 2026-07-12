import { NextRequest, NextResponse } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";
import { createAutomationService } from "@/lib/automation/service";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ success: false, error: "内部任务认证失败" }, { status: 403 });
  }

  try {
    const service = createAutomationService(request.nextUrl.origin);
    const reconciled = await service.engine.reconcileMatchT30Tasks();
    return NextResponse.json({
      success: true,
      count: reconciled.length,
      reconciled: reconciled.map((task) => task.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "赛前任务对账失败";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
