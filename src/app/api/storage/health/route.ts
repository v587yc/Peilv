import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest } from "@/lib/admin-auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getStorageBackendInfo } from "@/storage/database/storage-config";

export async function GET(request: NextRequest) {
  const authorization = authorizeAdminRequest(request);
  if (!authorization.ok) {
    return NextResponse.json({ success: false, error: authorization.error }, { status: authorization.status });
  }

  let storage: ReturnType<typeof getStorageBackendInfo>;
  try {
    storage = getStorageBackendInfo();
  } catch {
    return NextResponse.json({ success: false, error: "存储配置无效" }, { status: 503 });
  }

  try {
    const supabase = getSupabaseClient();
    const [{ error: healthError }, { data: migrations, error: migrationError }] = await Promise.all([
      supabase.from("health_check").select("id").limit(1),
      supabase.from("schema_migrations").select("version").order("applied_at", { ascending: false }).limit(1),
    ]);

    if (healthError) throw healthError;
    if (migrationError) throw migrationError;

    return NextResponse.json({
      success: true,
      storage,
      schemaVersion: migrations?.[0]?.version || null,
    });
  } catch (error) {
    console.error("Storage health check failed", error);
    return NextResponse.json({
      success: false,
      storage,
      error: "存储不可用",
    }, { status: 503 });
  }
}
