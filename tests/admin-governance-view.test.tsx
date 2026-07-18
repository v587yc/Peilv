// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernanceView } from "@/app/admin/_components/governance-view";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function renderView(kind: "automation" | "backtests", response: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, ...response }), { status: 200, headers: { "Content-Type": "application/json" } })));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root?.render(<GovernanceView kind={kind} capabilities={["admin:view", "admin:execute"]} />); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  return container;
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("admin governance view", () => {
  it("renders automation plans and tasks as readable status cards", async () => {
    const view = await renderView("automation", {
      plans: [{ id: "daily-analysis", name: "每日分析", status: "active", cron: "15 12 * * *" }],
      tasks: [{ id: "task-1", type: "analysis", status: "failed", updated_at: "2026-07-17" }],
    });
    expect(view.textContent).toContain("调度计划");
    expect(view.textContent).toContain("每日分析");
    expect(view.textContent).toContain("运行中");
    expect(view.textContent).toContain("最近任务");
    expect(view.textContent).toContain("失败");
  });

  it("validates backtest range and uses an explicit conservative match limit", async () => {
    const view = await renderView("backtests", { limits: { maxDateRangeDays: 7, maxMatches: 500 }, items: [] });
    const maxMatches = view.querySelector<HTMLInputElement>("#backtest-max-matches")!;
    expect(maxMatches.value).toBe("50");
    const start = view.querySelector<HTMLInputElement>("#backtest-start-date")!;
    const end = view.querySelector<HTMLInputElement>("#backtest-end-date")!;
    await act(async () => {
      changeInput(start, "2026-07-17");
    });
    await act(async () => {
      changeInput(end, "2026-07-01");
    });
    expect(view.textContent).toContain("结束日期不能早于开始日期");
    expect(Array.from(view.querySelectorAll("button")).find(button => button.textContent?.includes("启动回测"))?.disabled).toBe(true);
  });

  it("rejects unsafe match limits above the server maximum", async () => {
    const view = await renderView("backtests", { limits: { maxDateRangeDays: 7, maxMatches: 100 }, items: [] });
    const start = view.querySelector<HTMLInputElement>("#backtest-start-date")!;
    const end = view.querySelector<HTMLInputElement>("#backtest-end-date")!;
    const maxMatches = view.querySelector<HTMLInputElement>("#backtest-max-matches")!;
    await act(async () => { changeInput(start, "2026-07-01"); changeInput(end, "2026-07-07"); changeInput(maxMatches, "101"); });
    expect(view.textContent).toContain("赛事上限不能超过 100");
    expect(Array.from(view.querySelectorAll("button")).find(button => button.textContent?.includes("启动回测"))?.disabled).toBe(true);
  });

  it("renders a readable data-source summary before raw diagnostics", async () => {
    const view = await renderView("automation", { plans: [], tasks: [] });
    expect(view.textContent).toContain("当前没有调度计划");
    expect(view.textContent).toContain("当前没有任务记录");
  });
});
