export type DataBackend = "online" | "local";

export type StorageConfig = {
  backend: DataBackend;
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
};

type StorageEnvironment = Record<string, string | undefined>;

let activeConfig: StorageConfig | undefined;

function required(env: StorageEnvironment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

function normalizeHttpUrl(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} is invalid`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(`${key} must use HTTP or HTTPS without credentials`);
  }
  return url;
}

function validateLocalUrl(value: string): string {
  const url = normalizeHttpUrl(value, "LOCAL_SUPABASE_URL");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("LOCAL_SUPABASE_URL must use a loopback host");
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveStorageConfig(env: StorageEnvironment): StorageConfig {
  const rawBackend = env.DATA_BACKEND?.trim().toLowerCase() || "online";
  if (rawBackend !== "online" && rawBackend !== "local") {
    throw new Error("DATA_BACKEND must be online or local");
  }

  if (rawBackend === "local") {
    return {
      backend: "local",
      url: validateLocalUrl(required(env, "LOCAL_SUPABASE_URL")),
      anonKey: required(env, "LOCAL_SUPABASE_ANON_KEY"),
      serviceRoleKey: required(env, "LOCAL_SUPABASE_SERVICE_ROLE_KEY"),
    };
  }

  return {
    backend: "online",
    url: normalizeHttpUrl(required(env, "COZE_SUPABASE_URL"), "COZE_SUPABASE_URL").toString().replace(/\/$/, ""),
    anonKey: required(env, "COZE_SUPABASE_ANON_KEY"),
    serviceRoleKey: env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined,
  };
}

export function getStorageConfig(env: StorageEnvironment = process.env): StorageConfig {
  activeConfig ??= resolveStorageConfig(env);
  return activeConfig;
}

export function getStorageBackendInfo(config: StorageConfig = getStorageConfig()) {
  const url = new URL(config.url);
  return {
    backend: config.backend,
    host: url.host,
    serviceRoleConfigured: Boolean(config.serviceRoleKey),
  };
}

export function resetStorageConfigForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Storage configuration can only be reset in tests");
  }
  activeConfig = undefined;
}
