import { afterEach, describe, expect, it } from "vitest";
import {
  getSupabaseCredentials,
  getSupabaseServiceRoleKey,
} from "@/storage/database/supabase-client";
import { resetStorageConfigForTests } from "@/storage/database/storage-config";

const keys = [
  "DATA_BACKEND",
  "LOCAL_SUPABASE_URL",
  "LOCAL_SUPABASE_ANON_KEY",
  "LOCAL_SUPABASE_SERVICE_ROLE_KEY",
  "COZE_SUPABASE_URL",
  "COZE_SUPABASE_ANON_KEY",
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStorageConfigForTests();
});

describe("Supabase client backend selection", () => {
  it("uses local credentials without changing the caller-facing factory", () => {
    process.env.DATA_BACKEND = "local";
    process.env.LOCAL_SUPABASE_URL = "http://localhost:54321";
    process.env.LOCAL_SUPABASE_ANON_KEY = "local-anon";
    process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY = "local-service";
    process.env.COZE_SUPABASE_URL = "https://online.example.com";
    process.env.COZE_SUPABASE_ANON_KEY = "online-anon";

    expect(getSupabaseCredentials()).toEqual({
      url: "http://localhost:54321",
      anonKey: "local-anon",
    });
    expect(getSupabaseServiceRoleKey()).toBe("local-service");
  });
});
