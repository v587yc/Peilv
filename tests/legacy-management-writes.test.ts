import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const storage = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/storage/database/supabase-client", () => ({ getSupabaseClient: storage.get }));

import { POST as createStrategy } from "@/app/api/strategy/route";
import { POST as publishStrategy } from "@/app/api/strategy/[version]/publish/route";
import { POST as rollbackStrategy } from "@/app/api/strategy/[version]/rollback/route";
import { POST as startBacktest, DELETE as cancelBacktest } from "@/app/api/backtest/route";

const request = (path: string, method = "POST") => new NextRequest(`http://local${path}`, {
  method,
  headers: { "content-type": "application/json" },
  body: "{not-json",
});

describe("retired management mutations", () => {
  it.each([
    ["strategy create", () => createStrategy(request("/api/strategy"))],
    ["strategy publish", () => publishStrategy(request("/api/strategy/v1/publish"), { params: Promise.resolve({ version: "v1" }) })],
    ["strategy rollback", () => rollbackStrategy(request("/api/strategy/v1/rollback"), { params: Promise.resolve({ version: "v1" }) })],
    ["backtest create", () => startBacktest(request("/api/backtest"))],
    ["backtest control", () => cancelBacktest(request("/api/backtest", "DELETE"))],
  ])("returns 410 with zero storage side effects for %s", async (_name, invoke) => {
    storage.get.mockClear();
    const response = await invoke();
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ errorCode: "LEGACY_MANAGEMENT_WRITE_GONE" });
    expect(storage.get).not.toHaveBeenCalled();
  });
});
