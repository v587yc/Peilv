import { NextRequest, NextResponse } from "next/server";
import { loadSourcesOverview } from "@/features/management/sources-service";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { getSupabaseClient } from "@/storage/database/supabase-client";
export async function GET(request: NextRequest) { const auth = await requireAdminCapability(request, "admin:view"); if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status }); return NextResponse.json({ success: true, sections: await loadSourcesOverview(getSupabaseClient()) }, { headers: { "Cache-Control": "private, no-store" } }); }
