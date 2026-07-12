import { NextRequest, NextResponse } from "next/server";
import { beijingParts } from "@/lib/automation/definitions";
import { createAutomationService } from "@/lib/automation/service";
import type { AutomationTaskType } from "@/lib/automation/types";

const DAILY_TASK_TYPES: AutomationTaskType[] = [
  "odds-fetch",
  "crown-snapshot",
  "analysis",
  "verify-learn-report",
];

export async function GET(request: NextRequest) {
  try {
    const dateKey = request.nextUrl.searchParams.get("date") || beijingParts(new Date()).dateKey;
    if (!/^\d{8}$/.test(dateKey)) {
      return NextResponse.json({ success: false, error: "date必须是YYYYMMDD格式" }, { status: 400 });
    }
    const { repository } = createAutomationService(request.nextUrl.origin);
    const tasks = await repository.list({ dateKey, taskTypes: DAILY_TASK_TYPES, limit: 20 });
    const statusTasks = tasks.map((task) => ({
      id: task.id,
      taskType: task.taskType,
      dateKey: task.dateKey,
      status: task.status,
      currentStep: task.currentStep,
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      lastError: task.lastError,
      scheduledAt: task.scheduledAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      updatedAt: task.updatedAt,
      steps: task.steps.map((step) => ({
        stepKey: step.stepKey,
        ordinal: step.ordinal,
        status: step.status,
        attemptCount: step.attemptCount,
        maxAttempts: step.maxAttempts,
        lastError: step.lastError,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
      })),
    }));
    return NextResponse.json(
      { success: true, dateKey, tasks: statusTasks },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务状态查询失败";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
