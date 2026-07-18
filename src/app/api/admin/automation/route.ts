import { NextRequest, NextResponse } from "next/server";
import { compensateAutomation, loadAutomationGovernance } from "@/features/management/automation-governance";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { AUTOMATION_TASK_TYPES, type AutomationTaskType } from "@/lib/automation/types";
import { runRouteCommand } from "@/features/management/route-command";
import { getInternalAppBaseUrl } from "@/lib/internal-app-base-url";
const noStore = { "Cache-Control": "private, no-store" };
export async function GET(request: NextRequest) { const auth = await requireAdminCapability(request, "admin:view"); if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status }); try { return NextResponse.json({ success: true, ...(await loadAutomationGovernance(getInternalAppBaseUrl(), request.nextUrl.searchParams.get("date") || undefined)) }, { headers: noStore }); } catch { return NextResponse.json({ success: false, error: "自动化状态暂时不可用" }, { status: 503 }); } }
export async function POST(request: NextRequest) { const auth=await requireAdminCapability(request,"admin:execute"); if(!auth.ok)return NextResponse.json({success:false,error:auth.error},{status:auth.status}); return runRouteCommand(request,auth.principal,"automation.compensate",async payload=>{const types=payload.types as AutomationTaskType[];if(!Array.isArray(types)||!types.length||types.some(type=>!AUTOMATION_TASK_TYPES.includes(type)||type==="match-t30-analysis"))throw new Error("types invalid");return {tasks:await compensateAutomation(getInternalAppBaseUrl(),types)};});}
