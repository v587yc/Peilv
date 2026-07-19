// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Activity } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { AdminEmptyState, AdminPageHeader, AdminStatusBadge, RawDiagnostics } from "@/app/admin/_components/admin-ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
}

afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("admin visual and accessibility contract", () => {
  it("keeps one semantic page title and readable status text", async () => {
    const view = await render(<><AdminPageHeader eyebrow="Operations" icon={Activity} title="自动化" description="管理调度任务" /><AdminStatusBadge label="运行中" tone="running" /><AdminEmptyState title="暂无任务" description="新任务会显示在这里。" /></>);
    expect(view.querySelectorAll("h1")).toHaveLength(1);
    expect(view.textContent).toContain("运行中");
    expect(view.textContent).toContain("暂无任务");
  });

  it("keeps raw diagnostics collapsed by default", async () => {
    const view = await render(<RawDiagnostics value={{ secret: "redacted", status: "ok" }} />);
    const trigger = view.querySelector("button")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.textContent).not.toContain("redacted");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.textContent).toContain("redacted");
  });

  it("provides a labelled keyboard-focusable dialog and localized close control", async () => {
    await render(<Dialog><DialogTrigger>打开</DialogTrigger><DialogContent><DialogTitle>诊断详情</DialogTitle><DialogDescription>查看本次运行信息</DialogDescription></DialogContent></Dialog>);
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    await act(async () => trigger.click());
    expect(document.querySelector("[role=dialog]")?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.textContent).toContain("关闭对话框");
  });
});
