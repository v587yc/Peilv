import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'child_process';
import { getStorageConfig } from './storage-config';

let envLoadAttempted = false;
let serverClient: SupabaseClient | undefined;

interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

function hasSelectedCredentials(): boolean {
  if (process.env.DATA_BACKEND?.trim().toLowerCase() === 'local') {
    return Boolean(
      process.env.LOCAL_SUPABASE_URL
      && process.env.LOCAL_SUPABASE_ANON_KEY
      && process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY,
    );
  }
  return Boolean(process.env.COZE_SUPABASE_URL && process.env.COZE_SUPABASE_ANON_KEY);
}

function loadEnv(): void {
  if (envLoadAttempted || hasSelectedCredentials()) return;
  envLoadAttempted = true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('dotenv').config();
  } catch {
    // Environment variables may already be provided by the process.
  }

  if (hasSelectedCredentials() || process.env.DATA_BACKEND?.trim().toLowerCase() === 'local') return;

  const pythonCode = `
import sys
try:
    from coze_workload_identity import Client
    client = Client()
    env_vars = client.get_project_env_vars()
    client.close()
    for env_var in env_vars:
        print(f"{env_var.key}={env_var.value}")
except Exception as e:
    print(f"# Error: {e}", file=sys.stderr)
`;

  try {
    const output = execFileSync('python3', ['-c', pythonCode], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    for (const line of output.trim().split('\n')) {
      if (line.startsWith('#')) continue;
      const eqIndex = line.indexOf('=');
      if (eqIndex <= 0) continue;
      const key = line.substring(0, eqIndex);
      let value = line.substring(eqIndex + 1);
      if ((value.startsWith("'") && value.endsWith("'"))
          || (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // Missing configuration is reported by resolveStorageConfig without exposing provider details.
  }
}

function getSupabaseCredentials(): SupabaseCredentials {
  loadEnv();
  const { url, anonKey } = getStorageConfig();
  return { url, anonKey };
}

function getSupabaseServiceRoleKey(): string | undefined {
  loadEnv();
  return getStorageConfig().serviceRoleKey;
}

function getSupabaseClient(token?: string): SupabaseClient {
  loadEnv();
  const { url, anonKey, serviceRoleKey } = getStorageConfig();

  if (token) {
    return createClient(url, anonKey, {
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
      db: {
        timeout: 60000,
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  serverClient ??= createClient(url, serviceRoleKey ?? anonKey, {
    db: {
      timeout: 60000,
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return serverClient;
}

export { loadEnv, getSupabaseCredentials, getSupabaseServiceRoleKey, getSupabaseClient };
