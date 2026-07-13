import { NextRequest, NextResponse } from "next/server";
import { getRun, listRunArtifacts } from "@/lib/github/github-actions-adapter";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const runId = Number((await params).runId);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return NextResponse.json({ success: false, error: "无效的 run ID" }, { status: 400 });
  }
  try {
    const [run, artifacts] = await Promise.all([getRun(runId), listRunArtifacts(runId)]);
    return NextResponse.json({ success: true, run, artifacts }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ success: false, error: "无法读取 GitHub Actions 运行" }, { status: 503 });
  }
}
