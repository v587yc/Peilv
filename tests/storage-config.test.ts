import { describe, expect, it } from "vitest";
import { getStorageBackendInfo, resolveStorageConfig } from "@/storage/database/storage-config";

describe("storage configuration", () => {
  it("uses existing online variables by default", () => {
    expect(resolveStorageConfig({
      COZE_SUPABASE_URL: "https://example.supabase.co/",
      COZE_SUPABASE_ANON_KEY: "anon",
    })).toEqual({
      backend: "online",
      url: "https://example.supabase.co",
      anonKey: "anon",
      serviceRoleKey: undefined,
    });
  });

  it("selects a loopback local backend explicitly", () => {
    const config = resolveStorageConfig({
      DATA_BACKEND: "local",
      LOCAL_SUPABASE_URL: "http://127.0.0.1:54321/",
      LOCAL_SUPABASE_ANON_KEY: "local-anon",
      LOCAL_SUPABASE_SERVICE_ROLE_KEY: "local-service",
    });

    expect(config).toEqual({
      backend: "local",
      url: "http://127.0.0.1:54321",
      anonKey: "local-anon",
      serviceRoleKey: "local-service",
    });
    expect(getStorageBackendInfo(config)).toEqual({
      backend: "local",
      host: "127.0.0.1:54321",
      serviceRoleConfigured: true,
    });
  });

  it("rejects invalid modes and endpoints", () => {
    expect(() => resolveStorageConfig({ DATA_BACKEND: "hybrid" }))
      .toThrow("DATA_BACKEND must be online or local");
    expect(() => resolveStorageConfig({
      COZE_SUPABASE_URL: "postgres://database.example.com",
      COZE_SUPABASE_ANON_KEY: "anon",
    })).toThrow("COZE_SUPABASE_URL must use HTTP or HTTPS without credentials");
    expect(() => resolveStorageConfig({
      DATA_BACKEND: "local",
      LOCAL_SUPABASE_URL: "https://database.example.com",
      LOCAL_SUPABASE_ANON_KEY: "anon",
      LOCAL_SUPABASE_SERVICE_ROLE_KEY: "service",
    })).toThrow("LOCAL_SUPABASE_URL must use a loopback host");
  });

  it("names missing variables without leaking configured keys", () => {
    const secret = "must-not-appear";
    let message = "";
    try {
      resolveStorageConfig({
        DATA_BACKEND: "local",
        LOCAL_SUPABASE_URL: "http://localhost:54321",
        LOCAL_SUPABASE_ANON_KEY: secret,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("LOCAL_SUPABASE_SERVICE_ROLE_KEY is not set");
    expect(message).not.toContain(secret);
  });
});
