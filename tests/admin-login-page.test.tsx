// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminSession: vi.fn(),
  readAdminSession: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/login/auth-client", () => ({
  createAdminSession: mocks.createAdminSession,
  readAdminSession: mocks.readAdminSession,
}));

import LoginPage from "@/app/login/page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.readAdminSession.mockResolvedValue({ configured: true, initialized: true, authenticated: false, user: null });
  mocks.createAdminSession.mockRejectedValue(new Error("账号或密码无效"));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe("admin login page", () => {
  it("consumes explicit logout state without repeating the revoked session probe", async () => {
    sessionStorage.setItem("admin-explicit-logout", "1");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<LoginPage />); });
    await flush();
    expect(mocks.readAdminSession).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("admin-explicit-logout")).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("keeps a single semantic page title across responsive layouts", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<LoginPage />); });
    await flush();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe("欢迎回来");
  });

  it("shows local CLI guidance and no login form when the installation is uninitialized", async () => {
    mocks.readAdminSession.mockResolvedValue({ configured: true, initialized: false, authenticated: false, user: null });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<LoginPage />); });
    await flush();

    const initializationHeading = Array.from(container.querySelectorAll("h1")).find(heading => heading.textContent === "系统尚未初始化");
    expect(initializationHeading).toBeDefined();
    expect(container.textContent).toContain("此页面不会收集初始化 token");
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("#admin-username")).toBeNull();
    expect(container.querySelector("#admin-password")).toBeNull();

    const instructions = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("查看初始化说明"));
    expect(instructions?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { instructions?.click(); });
    expect(instructions?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("pnpm admin:bootstrap");

    const recheck = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("重新检查初始化状态"));
    expect(recheck).toBeDefined();
    mocks.readAdminSession.mockResolvedValue({ configured: true, initialized: true, authenticated: false, user: null });
    await act(async () => { recheck?.click(); });
    await flush();
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("restores password focus after a failed login without focusing the alert", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<LoginPage />); });
    await flush();

    const username = container.querySelector<HTMLInputElement>("#admin-username")!;
    const password = container.querySelector<HTMLInputElement>("#admin-password")!;
    await act(async () => {
      username.value = "root.admin";
      username.dispatchEvent(new Event("input", { bubbles: true }));
      password.value = "WrongPassword123";
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = container.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });

    const alert = container.querySelector<HTMLElement>("#login-error")!;
    expect(alert).not.toBeNull();
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("账号或密码无效");
    expect(password.disabled).toBe(false);
    expect(document.activeElement).toBe(password);
    expect(document.activeElement).not.toBe(alert);
  });
});
