import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getSupabaseClient: vi.fn() }));
vi.mock("@/storage/database/supabase-client", () => ({ getSupabaseClient: mocks.getSupabaseClient }));

import { GET as getSettings, POST as postSettings } from "@/app/api/settings/route";
import { GET as getPrediction, POST as postPrediction, DELETE as deletePrediction } from "@/app/api/prediction/route";

const secret = "Test_Internal_Secret_0123456789AB";
function internal(path: string, method: string) {
  return new NextRequest(`https://app.invalid${path}`, {
    method,
    headers: { "x-internal-api-secret": secret, "content-type": "application/json" },
    body: ["POST", "PATCH", "DELETE"].includes(method) ? "{}" : undefined,
  });
}

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = secret;
  mocks.getSupabaseClient.mockReset();
});

describe("legacy handler defense in depth", () => {
  it.each([
    ["settings GET", () => getSettings(internal("/api/settings", "GET"))],
    ["prediction GET", () => getPrediction(internal("/api/prediction", "GET"))],
    ["prediction POST", () => postPrediction(internal("/api/prediction", "POST"))],
    ["prediction DELETE", () => deletePrediction(internal("/api/prediction", "DELETE"))],
  ])("rejects internal actor at %s before storage side effects", async (_name, invoke) => {
    const response = await invoke();
    expect(response.status).toBe(403);
    expect(mocks.getSupabaseClient).not.toHaveBeenCalled();
  });

  it("rejects internal settings writes before compatibility handling or storage side effects", async () => {
    const response = await postSettings(internal("/api/settings", "POST"));
    expect(response.status).toBe(403);
    expect(mocks.getSupabaseClient).not.toHaveBeenCalled();
  });
});
