// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GovernanceView } from "@/app/admin/_components/governance-view";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(capabilities: Array<"admin:view" | "admin:configure" | "admin:execute" | "admin:dangerous" | "admin:manage">) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root?.render(<GovernanceView kind="strategies" capabilities={capabilities} />); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  return container;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, items: [
    { version: "strategy-v1", name: "Current", status: "draft", model_version: "model-v1" },
    { version: "strategy-v0", name: "Previous", status: "published", model_version: "model-v0" },
  ] }), { status: 200, headers: { "Content-Type": "application/json" } })));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove(); root = null; container = null;
  vi.unstubAllGlobals();
});

describe("governance capability depth", () => {
  it("lets operators create drafts but hides dangerous publish and rollback controls", async () => {
    const view = await render(["admin:view", "admin:configure", "admin:execute"]);
    expect(view.textContent).toContain("创建策略草稿");
    const buttons = Array.from(view.querySelectorAll("button")).map(button => button.textContent?.trim());
    expect(buttons).not.toContain("发布");
    expect(buttons).not.toContain("回退到此版本");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shows dangerous strategy lifecycle controls to super administrators", async () => {
    const view = await render(["admin:view", "admin:configure", "admin:execute", "admin:dangerous", "admin:manage"]);
    const buttons = Array.from(view.querySelectorAll("button")).map(button => button.textContent?.trim());
    expect(buttons).toContain("发布");
    expect(buttons).toContain("回退到此版本");
  });

  it("does not publish a strategy until the danger dialog is confirmed", async () => {
    const view = await render(["admin:view", "admin:configure", "admin:execute", "admin:dangerous", "admin:manage"]);
    const publish = Array.from(view.querySelectorAll("button")).find(button => button.textContent?.trim() === "发布")!;
    await act(async () => publish.click());
    expect(fetch).toHaveBeenCalledTimes(1);
    const confirm = Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "确认发布")!;
    expect(confirm).toBeTruthy();
    await act(async () => { confirm.click(); await Promise.resolve(); });
    const publishRequests = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(publishRequests).toHaveLength(1);
    expect(String(publishRequests[0]?.[1]?.body)).toContain('"targetId":"strategy.publish"');
  });
});
