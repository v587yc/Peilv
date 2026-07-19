import { NextRequest, NextResponse } from "next/server";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { SettingsGovernanceService, createSupabaseSettingsRepository } from "@/features/management/settings-service";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { runRouteCommand } from "@/features/management/route-command";
const headers = { "Cache-Control": "private, no-store" };
const service = () => new SettingsGovernanceService(createSupabaseSettingsRepository(getSupabaseClient()));
export async function GET(request: NextRequest) { const auth = await requireAdminCapability(request, "admin:view"); if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers }); try { return NextResponse.json({ success: true, settings: await service().list() }, { headers }); } catch { return NextResponse.json({ success: false, error: "设置暂时不可用" }, { status: 503, headers }); } }
export async function PATCH(request: NextRequest) { const auth = await requireAdminCapability(request, "admin:configure"); if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers }); return runRouteCommand(request, auth.principal, "settings.replace", async payload => ({ changedKeys: await service().update(payload.replacements as Record<string, unknown> || {}) })); }
