import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { loadPublishedStrategy } from "@/lib/analysis/strategy";
import { legacyManagementWriteGone } from "@/features/management/legacy-write";
import { isInternalRequest } from "@/lib/internal-auth";

export async function GET(request: NextRequest) {
  if (isInternalRequest(request)) return NextResponse.json({ error: "内部任务无权访问此接口" }, { status: 403 });
  try {
    const asOf = request.nextUrl.searchParams.get("asOf") || new Date().toISOString();
    if (Number.isNaN(Date.parse(asOf))) return NextResponse.json({ error: "asOf 无效" }, { status: 400 });
    const strategy = await loadPublishedStrategy(getSupabaseClient(), asOf);
    return NextResponse.json({ success: true, strategy, asOf });
  } catch (error) {
    console.error("[Strategy] Read failed:", error);
    return NextResponse.json({ error: "读取策略失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (isInternalRequest(request)) return NextResponse.json({ error: "内部任务无权访问此接口" }, { status: 403 });
  return legacyManagementWriteGone();
}
