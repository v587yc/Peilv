import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { isInternalRequest } from "@/lib/internal-auth";

function rejectInternal(request: Request) {
  return isInternalRequest(request) ? NextResponse.json({ error: "内部任务无权访问此接口" }, { status: 403 }) : null;
}

// GET: fetch by date, or list available dates
export async function GET(request: Request) {
  const denial = rejectInternal(request); if (denial) return denial;
  try {
    const { searchParams } = new URL(request.url);
    const dateKey = searchParams.get("date");
    const client = getSupabaseClient();

    if (dateKey) {
      // Read from DB by date
      const { data, error } = await client
        .from("prediction_data")
        .select("json_content")
        .eq("date_key", dateKey)
        .maybeSingle();

      if (error) {
        return NextResponse.json({ data: "", date: dateKey });
      }
      return NextResponse.json({ data: data?.json_content || "", date: dateKey });
    } else {
      // List all prediction dates from DB
      const { data, error } = await client
        .from("prediction_data")
        .select("date_key, updated_at")
        .order("date_key", { ascending: false })
        .limit(100);

      if (error) {
        return NextResponse.json({ dates: [] });
      }
      const dates = (data || []).map((row: { date_key: string }) => ({ date_key: row.date_key }));
      return NextResponse.json({ dates });
    }
  } catch {
    return NextResponse.json({ data: "", dates: [] });
  }
}

// POST: save prediction JSON for a specific date
export async function POST(request: Request) {
  const denial = rejectInternal(request); if (denial) return denial;
  try {
    const body = await request.json();
    const jsonStr = body.data || "";
    const dateKey = body.date || new Date().toISOString().slice(0, 10).replace(/-/g, "");

    const client = getSupabaseClient();
    const { error } = await client
      .from("prediction_data")
      .upsert(
        { date_key: dateKey, json_content: jsonStr, updated_at: new Date().toISOString() },
        { onConflict: "date_key" }
      );

    if (error) throw new Error(`保存失败: ${error.message}`);
    return NextResponse.json({ success: true, date: dateKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "保存失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE: remove a date's prediction
export async function DELETE(request: Request) {
  const denial = rejectInternal(request); if (denial) return denial;
  try {
    const { searchParams } = new URL(request.url);
    const dateKey = searchParams.get("date");
    if (!dateKey) return NextResponse.json({ error: "缺少日期参数" }, { status: 400 });

    const client = getSupabaseClient();
    const { error } = await client
      .from("prediction_data")
      .delete()
      .eq("date_key", dateKey);

    if (error) throw new Error(`删除失败: ${error.message}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "删除失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
