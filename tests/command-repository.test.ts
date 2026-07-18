import { describe, expect, it, vi } from "vitest";
import { createSupabaseCommandRepository } from "@/features/management/command-repository";

function updateQuery(data: unknown) {
  const query = { eq: vi.fn(), in: vi.fn(), select: vi.fn(), maybeSingle: vi.fn(async () => ({ data, error: null })) };
  query.eq.mockReturnValue(query); query.in.mockReturnValue(query); query.select.mockReturnValue(query);
  return query;
}

describe("Supabase command repository transitions", () => {
  it("uses a conditional from-state update and rejects a lost transition", async () => {
    const query = updateQuery(null);
    const client = { from: vi.fn(() => ({ update: vi.fn(() => query) })) };
    const repository = createSupabaseCommandRepository(client as never);
    await expect(repository.transition("settings.replace", "key", ["effect_started"], "effect_succeeded", { ok: true })).rejects.toThrow("无法推进管理命令状态");
    expect(query.in).toHaveBeenCalledWith("status", ["effect_started"]);
  });

  it("only marks pre-effect states failed", async () => {
    const query = updateQuery({ status: "failed" });
    const update = vi.fn(() => query);
    const client = { from: vi.fn(() => ({ update })) };
    const repository = createSupabaseCommandRepository(client as never);
    await repository.fail("settings.replace", "key", "safe");
    expect(query.in).toHaveBeenCalledWith("status", ["accepted", "executing", "effect_started"]);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
