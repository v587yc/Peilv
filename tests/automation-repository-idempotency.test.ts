import { describe, expect, it, vi } from "vitest";
import { SupabaseAutomationRepository } from "@/lib/automation/repository";
import { AUTOMATION_DEFINITIONS } from "@/lib/automation/definitions";

vi.mock("@/storage/database/supabase-client", () => ({
  getSupabaseClient: () => ({
    schema: vi.fn(() => ({
      rpc: vi.fn(async (_name: string, args: { p_task: Record<string, unknown> }) => ({
        data: [{ id: args.p_task.id, task_type: args.p_task.task_type, date_key: args.p_task.date_key, source: args.p_task.source, idempotency_key: args.p_task.idempotency_key, status: "pending", attempt_count: 0, max_attempts: 3, payload: args.p_task.payload, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], error: null,
      })),
    })),
    rpc: vi.fn(async (_name: string, args: { p_task: Record<string, unknown> }) => ({
      data: [{
        id: args.p_task.id,
        task_type: args.p_task.task_type,
        date_key: args.p_task.date_key,
        source: args.p_task.source,
        idempotency_key: args.p_task.idempotency_key,
        status: "pending",
        attempt_count: 0,
        max_attempts: 3,
        payload: args.p_task.payload,
        created_at: args.p_task.updated_at,
        updated_at: args.p_task.updated_at,
      }],
      error: null,
    })),
    from: vi.fn((table: string) => {
      if (table === "automation_task_steps") {
        const query = {
          upsert: vi.fn(async () => ({ error: null })),
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          order: vi.fn(() => query),
          then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => Promise.resolve(resolve({ data: [], error: null })),
        };
        return query;
      }
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        single: vi.fn(async () => ({
          data: {
            id: "task",
            task_type: "odds-fetch",
            date_key: "20260719",
            source: "production",
            idempotency_key: "key",
            status: "pending",
            attempt_count: 0,
            max_attempts: 3,
            payload: {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          error: null,
        })),
      };
      return query;
    }),
  }),
}));

describe("Supabase automation repository idempotency", () => {
  it("uses the atomic ensure RPC instead of insert/catch23505/select", async () => {
    const repository = new SupabaseAutomationRepository();
    const task = await repository.createIdempotent(
      { taskType: "odds-fetch", dateKey: "20260719", payload: { marker: "x" } },
      AUTOMATION_DEFINITIONS["odds-fetch"],
    );
    expect(task.id).toBeTypeOf("string");
  });
});
