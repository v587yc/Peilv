import { GET as getBacktest } from "@/features/backtest/runtime";
import { legacyManagementWriteGone } from "@/features/management/legacy-write";
import { NextResponse } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";

export async function GET(request: Parameters<typeof getBacktest>[0]) {
  if (isInternalRequest(request)) return NextResponse.json({ error: "内部任务无权访问此接口" }, { status: 403 });
  return getBacktest(request);
}
export async function POST(request?: Request) {
  if (request && isInternalRequest(request)) return NextResponse.json({ error: "内部任务无权访问此接口" }, { status: 403 });
  return legacyManagementWriteGone();
}
export async function DELETE(request?: Request) {
  if (request && isInternalRequest(request)) return NextResponse.json({ error: "内部任务无权访问此接口" }, { status: 403 });
  return legacyManagementWriteGone();
}
