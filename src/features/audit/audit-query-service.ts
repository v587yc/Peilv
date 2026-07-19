import { sanitizeAuditValue } from "@/lib/audit-log";
import type { AuditCursor, AuditLogDto, AuditLogRow, AuditPage, AuditQuery } from "./contracts";

export type AuditRepository = {
  query(input: AuditQuery): Promise<AuditLogRow[]>;
};

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeAuditCursor(value: string): AuditCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object") return null;
    const cursor = decoded as Record<string, unknown>;
    if (typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))) return null;
    if (!Number.isInteger(cursor.id) || Number(cursor.id) < 1) return null;
    return { createdAt: new Date(cursor.createdAt).toISOString(), id: Number(cursor.id) };
  } catch {
    return null;
  }
}

function project(row: AuditLogRow): AuditLogDto {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    action: row.action,
    objectType: row.object_type,
    objectId: row.object_id,
    requestId: row.request_id,
    oldValue: sanitizeAuditValue(row.old_value),
    newValue: sanitizeAuditValue(row.new_value),
    metadata: sanitizeAuditValue(row.metadata),
    createdAt: row.created_at,
  };
}

export async function queryAuditLogs(
  input: AuditQuery,
  repository: AuditRepository,
): Promise<AuditPage> {
  const rows = await repository.query({ ...input, limit: input.limit + 1 });
  const hasMore = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  const visible = (input.after ? pageRows.reverse() : pageRows).map(project);
  const first = visible[0];
  const last = visible.at(-1);

  return {
    items: visible,
    nextCursor: ((input.after && last) || (hasMore && last))
      ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id })
      : null,
    previousCursor: ((input.before && first) || (input.after && hasMore && first))
      ? encodeAuditCursor({ createdAt: first.createdAt, id: first.id })
      : null,
  };
}
