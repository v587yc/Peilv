import { NextRequest } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export const dynamic = "force-dynamic";

// GET /api/memory/entries?conversationId=default
export async function GET(request: NextRequest) {
  try {
    const conversationId = request.nextUrl.searchParams.get("conversationId") || "default";
    const type = request.nextUrl.searchParams.get("type"); // short, long, rule, or all

    const supabase = getSupabaseClient();

    let query = supabase
      .from("memory_bank")
      .select("id, memory_type, content, summary, keywords, score, original_id, created_at, compressed_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false });

    if (type && type !== "all") {
      query = query.eq("memory_type", type);
    }

    const { data, error } = await query.limit(200);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Stats
    const { data: stats } = await supabase
      .from("memory_bank")
      .select("memory_type, score")
      .eq("conversation_id", conversationId);

    const statMap: Record<string, { count: number; avgScore: number }> = {};
    (stats || []).forEach(s => {
      if (!statMap[s.memory_type]) statMap[s.memory_type] = { count: 0, avgScore: 0 };
      statMap[s.memory_type].count++;
      statMap[s.memory_type].avgScore += (s.score || 0);
    });
    Object.keys(statMap).forEach(k => {
      statMap[k].avgScore = statMap[k].count > 0 ? statMap[k].avgScore / statMap[k].count : 0;
    });

    return new Response(JSON.stringify({
      success: true,
      entries: data || [],
      stats: statMap,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "查询失败";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// DELETE /api/memory/entries?id=123 or ?conversationId=default&type=short
export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id");
    const conversationId = request.nextUrl.searchParams.get("conversationId");
    const type = request.nextUrl.searchParams.get("type");

    const supabase = getSupabaseClient();

    if (id) {
      const { error } = await supabase.from("memory_bank").delete().eq("id", Number(id));
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    } else if (conversationId && type) {
      const { error } = await supabase.from("memory_bank").delete().eq("conversation_id", conversationId).eq("memory_type", type);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    } else {
      return new Response(JSON.stringify({ error: "需要id或conversationId+type" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "删除失败";
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// PATCH /api/memory/entries - expand compressed memory back to short-term
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { originalId, conversationId } = body as { originalId: string; conversationId: string };

    if (!originalId || !conversationId) {
      return new Response(JSON.stringify({ error: "缺少originalId或conversationId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = getSupabaseClient();

    // Find compressed memory
    const { data: compressed } = await supabase
      .from("memory_bank")
      .select("id, content, summary, keywords, score")
      .eq("conversation_id", conversationId)
      .eq("memory_type", "long")
      .eq("original_id", originalId)
      .single();

    if (!compressed) {
      return new Response(JSON.stringify({ error: "找不到该压缩记忆" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Restore to short-term
    await supabase.from("memory_bank").insert({
      conversation_id: conversationId,
      memory_type: "short",
      content: compressed.content,
      score: compressed.score,
      keywords: compressed.keywords,
      original_id: originalId,
    });

    // Remove the compressed entry
    await supabase.from("memory_bank").delete().eq("id", compressed.id);

    return new Response(JSON.stringify({
      success: true,
      message: "记忆已从压缩存档恢复到短期记忆",
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "恢复失败";
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
