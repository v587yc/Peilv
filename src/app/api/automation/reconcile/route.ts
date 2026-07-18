import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedInternalRoute } from "@/lib/internal-auth";
import { createAutomationService } from "@/lib/automation/service";
import { getInternalAppBaseUrl } from "@/lib/internal-app-base-url";
import { reconcilePendingCommandAudits } from "@/features/management/command-reconciler";
import { reconcileExpiredBacktestLeases } from "@/features/backtest/runtime";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!isAuthorizedInternalRoute(request, "automation:reconcile")) {
    return NextResponse.json({ success: false, error: "内部任务认证失败" }, { status: 403 });
  }

  try {
    const service = createAutomationService(getInternalAppBaseUrl());
    const reconciled = await service.engine.reconcileMatchT30Tasks();
    const [commandAudits, expiredBacktests] = await Promise.all([
      reconcilePendingCommandAudits(25),
      reconcileExpiredBacktestLeases(25),
    ]);
    return NextResponse.json({
      success: true,
      count: reconciled.length,
      reconciled: reconciled.map((task) => task.id),
      commandAudits,
      expiredBacktests,
    });
  } catch (error) {
    console.error("[Automation] Reconcile failed:", error);
    return NextResponse.json({ success: false, error: "赛前任务对账失败" }, { status: 500 });
  }
}
