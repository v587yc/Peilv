import "server-only";
import { createHash } from "node:crypto";
import { Pool, type PoolConfig, type QueryResult } from "pg";
import type { StrategyLabSqlClient, StrategyLabSqlExecutor, StrategyLabSqlResult } from "./postgres-repository";

export interface StrategyLabPgPoolConfig {
  readonly databaseUrl: string;
  readonly ca?: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
}

export interface StrategyLabPgPoolLike {
  query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<Pick<QueryResult<Row>, "rows">>;
  connect(): Promise<StrategyLabPgPoolClientLike>;
  end(): Promise<void>;
}

export interface StrategyLabPgPoolClientLike {
  query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<Pick<QueryResult<Row>, "rows">>;
  release(): void;
}

export interface StrategyLabPgOwner {
  readonly client: StrategyLabSqlClient;
  close(): Promise<void>;
}

export class StrategyLabSqlDependencyError extends Error {
  readonly code?: string;
  readonly constraint?: string;

  constructor(error: unknown) {
    super("Strategy laboratory database dependency failed");
    this.name = "StrategyLabSqlDependencyError";
    const candidate = error && typeof error === "object" ? error as { code?: unknown; constraint?: unknown } : null;
    if (typeof candidate?.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) this.code = candidate.code;
    if (typeof candidate?.constraint === "string" && /^[a-zA-Z0-9_]{1,128}$/.test(candidate.constraint)) this.constraint = candidate.constraint;
    delete this.stack;
  }
}

const TRANSACTION_TIMEOUTS_SQL = `SELECT
  set_config('statement_timeout', $1, true),
  set_config('lock_timeout', $2, true),
  set_config('idle_in_transaction_session_timeout', $3, true)`;
const TRANSACTION_TIMEOUTS = ["3000ms", "1000ms", "5000ms"] as const;

function safeDependencyError(error: unknown): StrategyLabSqlDependencyError {
  return error instanceof StrategyLabSqlDependencyError ? error : new StrategyLabSqlDependencyError(error);
}

function executorFor(client: StrategyLabPgPoolClientLike): StrategyLabSqlExecutor {
  return Object.freeze({
    async query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []): Promise<StrategyLabSqlResult<Row>> {
      try {
        const result = await client.query<Row>(sql, parameters);
        return { rows: result.rows };
      } catch (error) {
        throw safeDependencyError(error);
      }
    },
  });
}

export function createStrategyLabSqlClient(pool: StrategyLabPgPoolLike): StrategyLabSqlClient {
  return Object.freeze({
    async query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []): Promise<StrategyLabSqlResult<Row>> {
      try {
        const result = await pool.query<Row>(sql, parameters);
        return { rows: result.rows };
      } catch (error) {
        throw safeDependencyError(error);
      }
    },

    async transaction<T>(callback: (transaction: StrategyLabSqlExecutor) => Promise<T>, options: Readonly<{ readOnly?: boolean; isolationLevel?: "repeatable read" }> = {}): Promise<T> {
      let client: StrategyLabPgPoolClientLike;
      try {
        client = await pool.connect();
      } catch (error) {
        throw safeDependencyError(error);
      }

      try {
        const transactionMode = `${options.isolationLevel === "repeatable read" ? " ISOLATION LEVEL REPEATABLE READ" : ""}${options.readOnly ? " READ ONLY" : ""}`;
        try { await client.query(`BEGIN${transactionMode}`); }
        catch (error) { throw safeDependencyError(error); }
        try { await client.query(TRANSACTION_TIMEOUTS_SQL, TRANSACTION_TIMEOUTS); }
        catch (error) {
          try { await client.query("ROLLBACK"); } catch { /* preserve timeout setup error */ }
          throw safeDependencyError(error);
        }

        let value: T;
        try {
          value = await callback(executorFor(client));
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch { /* preserve callback/query error */ }
          throw error;
        }

        try {
          await client.query("COMMIT");
          return value;
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch { /* preserve commit error */ }
          throw safeDependencyError(error);
        }
      } finally {
        try { client.release(); } catch { /* release must not replace the operation result */ }
      }
    },
  });
}

export function createStrategyLabPgPool(config: StrategyLabPgPoolConfig): Pool {
  const databaseUrl = config.databaseUrl.trim();
  if (!databaseUrl) throw new TypeError("Strategy laboratory database configuration is invalid");
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new TypeError("Strategy laboratory database configuration is invalid"); }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new TypeError("Strategy laboratory database configuration is invalid");
  }
  const max = config.maxConnections ?? 4;
  if (!Number.isInteger(max) || max < 1 || max > 5) throw new TypeError("Strategy laboratory pool configuration is invalid");
  const poolConfig: PoolConfig = {
    connectionString: databaseUrl,
    max,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 3_000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    allowExitOnIdle: true,
    ...(config.ca ? { ssl: { ca: config.ca, rejectUnauthorized: true } } : {}),
  };
  return new Pool(poolConfig);
}

export function createStrategyLabPgOwner(pool: StrategyLabPgPoolLike): StrategyLabPgOwner {
  const client = createStrategyLabSqlClient(pool);
  let closed = false;
  return Object.freeze({
    client,
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  });
}

const OWNER_KEY = Symbol.for("peilv.strategy-lab.pg-owner");
type GlobalWithOwner = typeof globalThis & { [OWNER_KEY]?: { readonly fingerprint: string; readonly owner: StrategyLabPgOwner } };

export function getOrCreateStrategyLabPgOwner(config: StrategyLabPgPoolConfig): StrategyLabPgOwner {
  const target = globalThis as GlobalWithOwner;
  const databaseUrl = config.databaseUrl.trim();
  const fingerprint = createHash("sha256").update(databaseUrl).digest("hex");
  if (target[OWNER_KEY]?.fingerprint === fingerprint) return target[OWNER_KEY].owner;
  if (target[OWNER_KEY]) throw new Error("Strategy laboratory database owner is already configured");
  const owner = createStrategyLabPgOwner(createStrategyLabPgPool(config));
  const wrapped = Object.freeze({
    client: owner.client,
    async close() {
      await owner.close();
      if (target[OWNER_KEY]?.owner === wrapped) delete target[OWNER_KEY];
    },
  });
  target[OWNER_KEY] = { fingerprint, owner: wrapped };
  return wrapped;
}
