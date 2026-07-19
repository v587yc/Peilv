import { describe, expect, it, vi } from "vitest";
import {
  formatHandicapLine,
  normalizeMatchDateKey,
  normalizeOpenTime,
  parsePredictions,
  previousDateKey,
} from "@/features/odds/workstation-domain";
import { createOddsRefreshQueue, createSerializedExecutor } from "@/features/odds/odds-fetch-orchestrator";

describe("odds workstation domain boundary", () => {
  it("decodes every supported prediction JSON shape and ignores malformed entries", () => {
    expect([...parsePredictions('[{"home":"主队","away":"客队","prediction":"主"}]')]).toEqual([
      ["主队_客队", expect.objectContaining({ prediction: "主" })],
    ]);
    expect([...parsePredictions('{"matches":[{"home":"A","away":"B"}]}').keys()]).toEqual(["A_B"]);
    expect([...parsePredictions('{"home":"单场","away":"客队"}').keys()]).toEqual(["单场_客队"]);
    expect(parsePredictions("broken").size).toBe(0);
    expect(parsePredictions('{"matches":[{"home":"","away":"B"}]}').size).toBe(0);
  });

  it("preserves opening-time, handicap and date normalization", () => {
    expect(normalizeOpenTime("4-6 7:09")).toBe("04-06 07:09");
    expect(normalizeOpenTime("")).toBe("zzz");
    expect(formatHandicapLine("*平/半")).toBe("受让平手/半球");
    expect(formatHandicapLine("一球")).toBe("一球");
    expect(normalizeMatchDateKey("2026-7-4")).toBe("20260704");
    expect(normalizeMatchDateKey("7月4日", 2026)).toBe("20260704");
    expect(previousDateKey("20260301")).toBe("20260228");
  });

  it("serializes arbitrary source tasks even after a rejection", async () => {
    const serialize = createSerializedExecutor();
    const events: string[] = [];
    const first = serialize(async () => { events.push("first"); throw new Error("failed"); });
    const second = serialize(async () => { events.push("second"); return 2; });
    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first", "second"]);
  });

  it("serializes source work, deduplicates flights and prioritizes queued requests", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<boolean>(resolve => { release = () => resolve(true); });
    const run = vi.fn(async (matchId: string) => {
      order.push(matchId);
      if (matchId === "first") return first;
      return true;
    });
    const statuses: Array<{ queued: number; inFlight: number }> = [];
    const queue = createOddsRefreshQueue({
      run,
      delay: async () => undefined,
      onStatus: status => statuses.push(status),
    });

    const firstRequest = queue.enqueue("first", 0, 1);
    const duplicate = queue.enqueue("first", 100, 1);
    const low = queue.enqueue("low", 1, 1);
    const high = queue.enqueue("high", 10, 1);
    release();

    await expect(Promise.all([firstRequest, duplicate, low, high])).resolves.toEqual([true, true, true, true]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(order).toEqual(["first", "high", "low"]);
    expect(statuses.at(-1)).toMatchObject({ queued: 0, inFlight: 0 });
  });

  it("cancels queued work without cancelling an active request", async () => {
    let release!: () => void;
    const active = new Promise<boolean>(resolve => { release = () => resolve(true); });
    const queue = createOddsRefreshQueue({ run: id => id === "active" ? active : Promise.resolve(true) });
    const running = queue.enqueue("active", 1, 1);
    const queued = queue.enqueue("queued", 1, 1);
    queue.clear();
    await expect(queued).resolves.toBe(false);
    release();
    await expect(running).resolves.toBe(true);
  });
});
