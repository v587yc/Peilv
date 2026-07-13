import { NextResponse } from "next/server";
import { getDeploymentOverview } from "@/lib/release-control/service";

export async function GET() {
  try {
    return NextResponse.json(
      { success: true, overview: await getDeploymentOverview() },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[Deployments] Failed to load overview:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { success: false, error: "暂时无法读取 GitHub 发布状态，请稍后重试" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
