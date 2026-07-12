import dns from "node:dns/promises";
import net from "node:net";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_HOSTS = new Set([
  "coze.cn",
  "www.coze.cn",
]);

function configuredHosts(): Set<string> {
  const configured = process.env.FETCH_URL_ALLOWED_HOSTS || "";
  return new Set(configured.split(",").map(host => host.trim().toLowerCase()).filter(Boolean));
}

export function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const allowed = new Set([...ALLOWED_HOSTS, ...configuredHosts()]);
  return [...allowed].some(candidate => host === candidate || host.endsWith(`.${candidate}`));
}

export function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : "";
    if (net.isIPv4(mappedIpv4)) return isPrivateIp(mappedIpv4);
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("ff");
  }

  return true;
}

export function assertUrlPolicy(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error("仅允许访问 HTTPS 地址");
  }
  if (url.username || url.password) {
    throw new Error("URL 不允许包含凭据");
  }
  if (!isAllowedHost(url.hostname)) {
    throw new Error("目标域名不在允许列表中");
  }
}

export function resolveRedirect(
  current: URL,
  status: number,
  location: string | null,
  redirectCount: number,
): URL | null {
  if (status < 300 || status >= 400) return null;
  if (redirectCount >= MAX_REDIRECTS) throw new Error("重定向次数超过限制");
  if (!location) throw new Error("重定向缺少目标地址");
  return new URL(location, current);
}

async function assertSafeTarget(url: URL): Promise<void> {
  assertUrlPolicy(url);

  const addresses = net.isIP(url.hostname)
    ? [url.hostname]
    : (await dns.lookup(url.hostname, { all: true })).map(result => result.address);
  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new Error("目标地址不可访问");
  }
}

async function readLimitedBody(response: Response): Promise<string> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("响应内容超过大小限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

export async function safeFetchText(input: string): Promise<{ textContent: string; resolvedUrl: string }> {
  if (input.length > 4096) {
    throw new Error("URL 长度超过限制");
  }

  let current = new URL(input);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    await assertSafeTarget(current);
    const response = await fetch(current, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });

    const redirectTarget = resolveRedirect(
      current,
      response.status,
      response.headers.get("location"),
      redirect,
    );
    if (redirectTarget) {
      current = redirectTarget;
      continue;
    }

    if (!response.ok) {
      throw new Error(`抓取失败: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/(json|text|javascript|octet-stream)/i.test(contentType)) {
      throw new Error("响应内容类型不受支持");
    }
    return { textContent: await readLimitedBody(response), resolvedUrl: current.toString() };
  }

  throw new Error("抓取失败");
}
