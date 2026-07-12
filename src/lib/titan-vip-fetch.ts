import type { IncomingHttpHeaders, IncomingMessage } from "http";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { promisify } from "node:util";
import { enqueueSerialTask, type SerialTaskQueue } from "@/lib/serial-task-queue";

const decompressors = {
  br: promisify(brotliDecompress),
  deflate: promisify(inflate),
  gzip: promisify(gunzip),
};

export type TitanFetchErrorCode =
  | "UPSTREAM_BLOCKED"
  | "UPSTREAM_BODY_TOO_LARGE"
  | "UPSTREAM_DECOMPRESSION"
  | "UPSTREAM_HTTP"
  | "UPSTREAM_REDIRECT"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_TRANSPORT";

export class TitanFetchError extends Error {
  constructor(
    public readonly code: TitanFetchErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "TitanFetchError";
  }
}

export interface TitanFetchResponse {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  attemptCount: number;
  redirectCount: number;
}

interface DirectResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function isAllowedTitanUrl(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === "titan007.com" || url.hostname.endsWith(".titan007.com"));
}

function requestDirect(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
): Promise<DirectResponse> {
  return new Promise<DirectResponse>(async (resolve, reject) => {
    const { default: https } = await import("https");
    const urlObj = new URL(url);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers,
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxBytes) {
            res.destroy();
            fail(new TitanFetchError("UPSTREAM_BODY_TOO_LARGE", `upstream body exceeded ${maxBytes} bytes`, false, res.statusCode));
            return;
          }
          chunks.push(buffer);
        });
        res.on("error", fail);
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on("error", error => {
      fail(error instanceof TitanFetchError
        ? error
        : new TitanFetchError("UPSTREAM_TRANSPORT", error.message, true));
    });
    req.on("timeout", () => {
      req.destroy();
      fail(new TitanFetchError("UPSTREAM_TIMEOUT", "upstream request timed out", true));
    });
    req.end();
  });
}

async function decompressBody(body: Buffer, contentEncoding: string | undefined): Promise<Buffer> {
  const encoding = contentEncoding?.split(",")[0]?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return body;
  const decompress = decompressors[encoding as keyof typeof decompressors];
  if (!decompress) {
    throw new TitanFetchError("UPSTREAM_DECOMPRESSION", `unsupported content encoding: ${encoding}`, false);
  }
  try {
    return await decompress(body);
  } catch (error) {
    throw new TitanFetchError(
      "UPSTREAM_DECOMPRESSION",
      error instanceof Error ? error.message : "failed to decompress upstream response",
      true,
    );
  }
}

function detectAsciiBlock(body: Buffer, hostname: string): void {
  const sample = body.toString("latin1", 0, Math.min(body.length, 16_384)).toLowerCase();
  if (/(captcha|access denied|too many requests|rate limit|cf-chl-|challenge-platform|verify you are human)/i.test(sample)) {
    throw new TitanFetchError("UPSTREAM_BLOCKED", `upstream blocked response from ${hostname}`, true);
  }
}

async function requestWithRedirects(
  requestedUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  maxRedirects: number,
): Promise<Omit<TitanFetchResponse, "requestedUrl" | "attemptCount">> {
  let currentUrl = requestedUrl;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const current = new URL(currentUrl);
    if (!isAllowedTitanUrl(current)) {
      throw new TitanFetchError("UPSTREAM_REDIRECT", `disallowed Titan URL: ${current.hostname}`, false);
    }
    const response = await requestDirect(currentUrl, headers, timeoutMs, maxBytes);
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location;
      if (!location || redirectCount === maxRedirects) {
        throw new TitanFetchError("UPSTREAM_REDIRECT", "invalid or excessive upstream redirect", false, response.statusCode);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const retryable = response.statusCode === 429 || response.statusCode >= 500;
      throw new TitanFetchError("UPSTREAM_HTTP", `upstream http ${response.statusCode} from ${current.hostname}`, retryable, response.statusCode);
    }
    const body = await decompressBody(response.body, response.headers["content-encoding"]);
    if (body.length > maxBytes) {
      throw new TitanFetchError("UPSTREAM_BODY_TOO_LARGE", `decompressed body exceeded ${maxBytes} bytes`, false, response.statusCode);
    }
    detectAsciiBlock(body, current.hostname);
    return {
      finalUrl: currentUrl,
      statusCode: response.statusCode,
      headers: response.headers,
      body,
      redirectCount,
    };
  }
  throw new TitanFetchError("UPSTREAM_REDIRECT", "unreachable redirect state", false);
}

const titanRequestState = (globalThis as typeof globalThis & {
  __titanRequestState?: SerialTaskQueue;
}).__titanRequestState ??= { tail: Promise.resolve() };

async function fetchTitanUrlDirect(
  url: string,
  headers: Record<string, string>,
  retries: number,
  timeoutMs: number,
  maxBytes: number,
  maxRedirects: number,
): Promise<TitanFetchResponse> {
  const urlObj = new URL(url);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await requestWithRedirects(url, headers, timeoutMs, maxBytes, maxRedirects);
      return { requestedUrl: url, attemptCount: attempt + 1, ...response };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof TitanFetchError ? error.retryable : true;
      if (!retryable || attempt === retries) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (lastError instanceof TitanFetchError) {
    throw new TitanFetchError(
      lastError.code,
      `Failed after ${retries + 1} attempts: ${urlObj.hostname}${urlObj.pathname}: ${lastError.message}`,
      lastError.retryable,
      lastError.statusCode,
    );
  }
  throw new TitanFetchError(
    "UPSTREAM_TRANSPORT",
    `Failed after ${retries + 1} attempts: ${urlObj.hostname}${urlObj.pathname}`,
    true,
  );
}

export function fetchTitanUrl(
  url: string,
  headers: Record<string, string>,
  retries = 2,
  timeoutMs = 15_000,
  maxBytes = 5 * 1024 * 1024,
  maxRedirects = 3,
): Promise<TitanFetchResponse> {
  return enqueueSerialTask(
    titanRequestState,
    () => fetchTitanUrlDirect(url, headers, retries, timeoutMs, maxBytes, maxRedirects),
  );
}

export async function fetchTitanUrlBuffer(
  url: string,
  headers: Record<string, string>,
  retries = 2,
  timeoutMs = 15_000,
): Promise<Buffer> {
  return (await fetchTitanUrl(url, headers, retries, timeoutMs)).body;
}
