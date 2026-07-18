import { NextRequest, NextResponse } from "next/server";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { loadManagementOverview } from "@/features/management/overview-service";

export async function GET(request: NextRequest) {
  const auth = await requireAdminCapability(request, "admin:view");
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
  return NextResponse.json({ success: true, ...(await loadManagementOverview(getSupabaseClient())) }, { headers: { "Cache-Control": "private, no-store" } });
}
