// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAdminUserServerObject, buildAdminUserPatchBody, type AdminUserMutationAction, useAdminUserMutationRegistry } from "@/app/admin/_components/admin-users-view";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Registry = ReturnType<typeof useAdminUserMutationRegistry>;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Harness({ expose }: { expose: (registry: Registry) => void }) {
  const registry = useAdminUserMutationRegistry();
  expose(registry);
  return (
    <div>
      <span data-testid="user-a">{registry.isActive("user-a") ? "busy" : "idle"}</span>
      <span data-testid="user-b">{registry.isActive("user-b") ? "busy" : "idle"}</span>
    </div>
  );
}

async function renderRegistry() {
  container = document.createElement("div");
  document.body.appendChild(container);
  let current!: Registry;
  root = createRoot(container);
  await act(async () => { root?.render(<Harness expose={registry => { current = registry; }} />); });
  return () => current;
}

function state(userId: string) {
  return container?.querySelector(`[data-testid="${userId}"]`)?.textContent;
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("admin user mutation registry", () => {
  it("sends the rendered server version and adopts the complete server object", () => {
    const original = { id: "user-a", username: "alpha", displayName: "Alpha", role: "operator" as const, isActive: true, lastLoginAt: null, createdAt: "created", updatedAt: "version-a" };
    const server = { ...original, role: "auditor" as const, isActive: false, updatedAt: "version-b" };
    expect(buildAdminUserPatchBody(original, { role: "super_admin" })).toEqual({ role: "super_admin", expectedUpdatedAt: "version-a" });
    expect(applyAdminUserServerObject([original], server)).toEqual([server]);
  });

  it("keeps the second account busy when the first deferred mutation settles", async () => {
    const registry = await renderRegistry();
    const first = deferred<string>();
    const second = deferred<string>();
    let firstRun!: Promise<string | undefined>;
    let secondRun!: Promise<string | undefined>;

    await act(async () => {
      firstRun = registry().run("user-a", "role", () => first.promise);
      secondRun = registry().run("user-b", "status", () => second.promise);
    });
    expect(state("user-a")).toBe("busy");
    expect(state("user-b")).toBe("busy");

    await act(async () => { first.resolve("first"); await firstRun; });
    expect(state("user-a")).toBe("idle");
    expect(state("user-b")).toBe("busy");

    await act(async () => { second.resolve("second"); await secondRun; });
    expect(state("user-b")).toBe("idle");
  });

  it("does not let an older response clear or apply over a newer mutation with the same key", async () => {
    const registry = await renderRegistry();
    const oldRequest = deferred<string>();
    const newRequest = deferred<string>();
    let oldRun!: Promise<string | undefined>;
    let newRun!: Promise<string | undefined>;
    const action: AdminUserMutationAction = "role";

    await act(async () => {
      oldRun = registry().run("user-a", action, () => oldRequest.promise);
      newRun = registry().run("user-a", action, () => newRequest.promise);
    });
    await act(async () => { oldRequest.resolve("old"); });
    expect(await oldRun).toBeUndefined();
    expect(state("user-a")).toBe("busy");

    await act(async () => { newRequest.resolve("new"); });
    expect(await newRun).toBe("new");
    expect(state("user-a")).toBe("idle");
  });
});
