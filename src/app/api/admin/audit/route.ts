import { NextRequest, NextResponse } from "next/server";
import { decodeAuditCursor, queryAuditLogs, type AuditRepository } from "@/features/audit/audit-query-service";
import type { AuditActorType, AuditLogRow, AuditQuery } from "@/features/audit/contracts";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export const REQUIRED_CAPABILITY = "admin:view" as const;
const NO_STORE = { "Cache-Control": "private, no-store" };
const ACTOR_TYPES = new Set<AuditActorType>(["admin", "internal", "system", "deployment-admin"]);

function invalid(error: string) {
  return NextResponse.json({ success: false, error }, { status: 400, headers: NO_STORE });
}

function boundedText(params: URLSearchParams, key: string): string | undefined | null {
  const value = params.get(key)?.trim();
  if (!value) return undefined;
  return value.length <= 200 ? value : null;
}

function parseQuery(params: URLSearchParams): AuditQuery | string {
  const limitText = params.get("limit");
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return "limit 必须是 1 到 100 的整数";

  const actorId = boundedText(params, "actorId");
  const action = boundedText(params, "action");
  const objectType = boundedText(params, "objectType");
  const objectId = boundedText(params, "objectId");
  const requestId = boundedText(params, "requestId");
  if ([actorId, action, objectType, objectId, requestId].includes(null)) return "筛选值过长";

  const actorTypeText = params.get("actorType")?.trim();
  if (actorTypeText && !ACTOR_TYPES.has(actorTypeText as AuditActorType)) return "actorType 无效";

  const parseDate = (key: string): string | undefined | null => {
    const value = params.get(key);
    if (!value) return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  };
  const from = parseDate("from");
  const to = parseDate("to");
  if (from === null || to === null || (from && to && from > to)) return "时间范围无效";

  const beforeText = params.get("before");
  const afterText = params.get("after");
  if (beforeText && afterText) return "不能同时使用 before 和 after 游标";
  const before = beforeText ? decodeAuditCursor(beforeText) : undefined;
  const after = afterText ? decodeAuditCursor(afterText) : undefined;
  if ((beforeText && !before) || (afterText && !after)) return "游标无效";

  return {
    limit,
    actorId: actorId || undefined,
    actorType: actorTypeText as AuditActorType | undefined,
    action: action || undefined,
    objectType: objectType || undefined,
    objectId: objectId || undefined,
    requestId: requestId || undefined,
    from: from || undefined,
    to: to || undefined,
    before: before || undefined,
    after: after || undefined,
  };
}

function createRepository(): AuditRepository {
  return {
    async query(input) {
      let query = getSupabaseClient()
        .from("audit_logs")
        .select("id, actor_id, actor_type, action, object_type, object_id, request_id, old_value, new_value, metadata, created_at");
      if (input.actorId) query = query.eq("actor_id", input.actorId);
      if (input.actorType) query = query.eq("actor_type", input.actorType);
      if (input.action) query = query.eq("action", input.action);
      if (input.objectType) query = query.eq("object_type", input.objectType);
      if (input.objectId) query = query.eq("object_id", input.objectId);
      if (input.requestId) query = query.eq("request_id", input.requestId);
      if (input.from) query = query.gte("created_at", input.from);
      if (input.to) query = query.lte("created_at", input.to);
      if (input.before) {
        query = query.or(`created_at.lt.${input.before.createdAt},and(created_at.eq.${input.before.createdAt},id.lt.${input.before.id})`);
      }
      if (input.after) {
        query = query.or(`created_at.gt.${input.after.createdAt},and(created_at.eq.${input.after.createdAt},id.gt.${input.after.id})`);
      }
      const ascending = Boolean(input.after);
      const { data, error } = await query
        .order("created_at", { ascending })
        .order("id", { ascending })
        .limit(input.limit);
      if (error) throw new Error("审计查询失败");
      return (data || []) as AuditLogRow[];
    },
  };
}

export async function GET(request: NextRequest) {
  const authorization = await requireAdminCapability(request, REQUIRED_CAPABILITY);
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status, headers: NO_STORE },
    );
  }

  const parsed = parseQuery(request.nextUrl.searchParams);
  if (typeof parsed === "string") return invalid(parsed);

  try {
    const page = await queryAuditLogs(parsed, createRepository());
    return NextResponse.json({ success: true, ...page }, { headers: NO_STORE });
  } catch (error) {
    console.error("[Admin Audit] Query failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { success: false, error: "审计日志暂时不可用" },
      { status: 500, headers: NO_STORE },
    );
  }
}
