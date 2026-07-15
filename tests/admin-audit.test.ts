import { describe, expect, it } from "vitest";
import { decodeAuditCursor, encodeAuditCursor, queryAuditLogs } from "@/features/audit/audit-query-service";
import type { AuditLogRow } from "@/features/audit/contracts";

function row(id: number): AuditLogRow {
  return {
    id,
    actor_id: "single-team-admin",
    actor_type: "admin",
    action: "settings.update",
    object_type: "setting",
    object_id: `setting-${id}`,
    request_id: `request-${id}`,
    old_value: { apiToken: "legacy-secret", nested: { password: "secret" } },
    new_value: null,
    metadata: { authorization: "Bearer secret", safe: "visible" },
    created_at: `2026-07-15T00:00:0${id}.000Z`,
  };
}

describe("audit query service", () => {
  it("projects browser DTOs, sanitizes legacy values, and creates stable cursors", async () => {
    const page = await queryAuditLogs({ limit: 2 }, { query: async input => {
      expect(input.limit).toBe(3);
      return [row(3), row(2), row(1)];
    } });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].oldValue).toEqual({ apiToken: "[redacted]", nested: { password: "[redacted]" } });
    expect(page.items[0].metadata).toEqual({ authorization: "[redacted]", safe: "visible" });
    expect(decodeAuditCursor(page.nextCursor!)).toEqual({ createdAt: row(2).created_at, id: 2 });
  });

  it("returns previous-page rows in descending display order with correct edge cursors", async () => {
    const after = { createdAt: "2026-07-15T00:00:01.000Z", id: 1 };
    const page = await queryAuditLogs({ limit: 2, after }, { query: async input => {
      expect(input.limit).toBe(3);
      expect(input.after).toEqual(after);
      // Repository returns ascending rows for an after cursor so the nearest
      // records can be limited before the service restores display order.
      return [row(2), row(3), row(4)];
    } });

    expect(page.items.map(item => item.id)).toEqual([3, 2]);
    expect(decodeAuditCursor(page.previousCursor!)).toEqual({ createdAt: row(3).created_at, id: 3 });
    expect(decodeAuditCursor(page.nextCursor!)).toEqual({ createdAt: row(2).created_at, id: 2 });
  });

  it("rejects malformed cursors", () => {
    expect(decodeAuditCursor("invalid")).toBeNull();
    expect(decodeAuditCursor(encodeAuditCursor({ createdAt: "2026-07-15T00:00:00.000Z", id: 1 }))).toEqual({
      createdAt: "2026-07-15T00:00:00.000Z", id: 1,
    });
  });
});
