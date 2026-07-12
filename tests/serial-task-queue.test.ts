import { describe, expect, it } from "vitest";
import { enqueueSerialTask, type SerialTaskQueue } from "@/lib/serial-task-queue";

describe("serial task queue", () => {
  it("runs concurrent submissions one at a time and continues after failure", async () => {
    const queue: SerialTaskQueue = { tail: Promise.resolve() };
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const run = (name: string, fail = false) => enqueueSerialTask(queue, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${name}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      order.push(`end:${name}`);
      if (fail) throw new Error(name);
      return name;
    });

    const results = await Promise.allSettled([
      run("first"),
      run("second", true),
      run("third"),
    ]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "start:first", "end:first",
      "start:second", "end:second",
      "start:third", "end:third",
    ]);
    expect(results.map(result => result.status)).toEqual([
      "fulfilled", "rejected", "fulfilled",
    ]);
  });
});
