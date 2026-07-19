// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/admin/audit" }));

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/app/admin/_components/admin-session-context", () => ({
  ADMIN_ROLE_LABELS: { super_admin: "超级管理员" },
  useAdminSession: () => ({ loading: false, user: { id: "admin-1", username: "root.admin", role: "super_admin" } }),
}));
vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => <button type="button">切换侧栏</button> }));

import { AdminHeader } from "@/app/admin/_components/admin-header";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function renderHeader() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<AdminHeader />));
  return container;
}

function logoutButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll("button")).find(button => button.textContent === "退出")!;
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("AdminHeader logout", () => {
  it("hard-navigates only to the clean login URL after revocation succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
    const container = await renderHeader();

    await act(async () => logoutButton(container).click());

    expect(fetch).toHaveBeenCalledWith("/api/auth/session", { method: "DELETE" });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("shows an error and does not navigate when revocation fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
    const container = await renderHeader();

    await act(async () => logoutButton(container).click());

    expect(replace).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("退出失败，请重试");
    expect(logoutButton(container).disabled).toBe(false);
  });
});
