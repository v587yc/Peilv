import { NextRequest, NextResponse } from "next/server";
import { SettingsGovernanceService, createSupabaseSettingsRepository, MASKED_SETTING_VALUE } from "@/features/management/settings-service";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { legacyManagementWriteGone } from "@/features/management/legacy-write";
import { isInternalRequest } from "@/lib/internal-auth";

const service = () => new SettingsGovernanceService(createSupabaseSettingsRepository(getSupabaseClient()));
export async function GET(request: NextRequest) {
  if (isInternalRequest(request)) return NextResponse.json({ error: "内部任务无权访问此接口" }, { status: 403 });
  try {
    const settings = Object.fromEntries((await service().list()).filter(item => item.configured || !item.sensitive).map(item => [item.key, item.sensitive ? MASKED_SETTING_VALUE : item.value || ""]));
    return NextResponse.json({ success: true, settings });
  } catch { return NextResponse.json({ error: "获取设置失败" }, { status: 500 }); }
}
export async function POST(request: NextRequest) {
  if (isInternalRequest(request)) return NextResponse.json({ error: "内部任务无权访问此接口" }, { status: 403 });
  return legacyManagementWriteGone();
}
