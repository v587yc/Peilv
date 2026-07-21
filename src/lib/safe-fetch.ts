import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

export type OutboundUrlKind = "fetch-url" | "llm" | "search" | "feishu";
type ResolvedAddress = { address: string; family: 4 | 6 };
type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const DEFAULT_ALLOWED_HOSTS: Record<OutboundUrlKind, readonly string[]> = {
  "fetch-url": ["coze.cn", "www.coze.cn"],
  llm: ["api.openai.com"],
  search: ["api.tavily.com"],
  feishu: ["open.feishu.cn", "open.larksuite.com"],
};

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function ipLiteralValue(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
}

function isForbiddenHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain";
}

function parseConfiguredHosts(value: string | undefined): string[] {
  return (value || "").split(",").map(normalizeHostname).filter(Boolean);
}

function configuredHosts(kind: OutboundUrlKind): string[] {
  const legacy = kind === "fetch-url" ? parseConfiguredHosts(process.env.FETCH_URL_ALLOWED_HOSTS) : [];
  return [...legacy, ...parseConfiguredHosts(process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS)];
}

function hostMatches(host: string, rule: string): boolean {
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return Boolean(suffix) && host.endsWith(`.${suffix}`) && host !== suffix;
  }
  return host === rule;
}

export function isAllowedHost(hostname: string, kind: OutboundUrlKind = "fetch-url"): boolean {
  const host = normalizeHostname(hostname);
  if (!host || net.isIP(ipLiteralValue(host)) !== 0) return false;
  const allowed = [...DEFAULT_ALLOWED_HOSTS[kind], ...configuredHosts(kind)];
  return allowed.some(rule => hostMatches(host, rule));
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => (value * 256) + Number(octet), 0) >>> 0;
}

function inIpv4Cidr(address: string, network: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

export function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    return [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4],
    ].some(([network, prefix]) => inIpv4Cidr(address, String(network), Number(prefix)));
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase().split("%")[0];
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) return isPrivateIp(mappedIpv4);
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const value = (Number.parseInt(mappedHex[1], 16) * 65536) + Number.parseInt(mappedHex[2], 16);
      return isPrivateIp(`${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`);
    }
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:") || normalized.startsWith("2001:0:") ||
      normalized.startsWith("2002:") || !/^[23][0-9a-f]{3}:/.test(normalized);
  }

  return true;
}

function configuredPorts(): Set<string> {
  return new Set((process.env.ADMIN_OUTBOUND_ALLOWED_PORTS || "")
    .split(",").map(port => port.trim()).filter(port => /^\d{1,5}$/.test(port) && Number(port) <= 65535));
}

export function assertUrlPolicy(url: URL, kind: OutboundUrlKind = "fetch-url"): void {
  if (url.protocol !== "https:") throw new Error("仅允许访问 HTTPS 地址");
  if (url.username || url.password) throw new Error("URL 不允许包含凭据");
  if (url.hash) throw new Error("URL 不允许包含 fragment");
  if (net.isIP(ipLiteralValue(url.hostname)) !== 0) throw new Error("URL 不允许使用 IP 字面量");
  if (isForbiddenHostname(url.hostname)) throw new Error("URL 不允许使用本地主机名");
  if (url.port && url.port !== "443" && !configuredPorts().has(url.port)) {
    throw new Error("目标端口不在允许列表中");
  }
  if (!isAllowedHost(url.hostname, kind)) throw new Error("目标域名不在允许列表中");
}

export function assertOutboundUrl(input: string, kind: OutboundUrlKind): URL {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096) throw new Error("URL 长度或格式无效");
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("URL 格式无效"); }
  assertUrlPolicy(url, kind);
  return url;
}

export function resolveRedirect(current: URL, status: number, location: string | null, redirectCount: number): URL | null {
  if (status < 300 || status >= 400) return null;
  if (redirectCount >= MAX_REDIRECTS) throw new Error("重定向次数超过限制");
  if (!location) throw new Error("重定向缺少目标地址");
  return new URL(location, current);
}

const defaultResolver: Resolver = async hostname => (await dns.lookup(hostname, { all: true, verbatim: true }))
  .map(result => ({ address: result.address, family: result.family as 4 | 6 }));

export async function resolveSafeAddresses(url: URL, kind: OutboundUrlKind, resolver: Resolver = defaultResolver): Promise<ResolvedAddress[]> {
  assertUrlPolicy(url, kind);
  const addresses = await resolver(url.hostname);
  if (addresses.length === 0 || addresses.some(item => net.isIP(item.address) !== item.family || isPrivateIp(item.address))) {
    throw new Error("目标 DNS 解析包含不可访问地址");
  }
  return addresses;
}

async function pinnedHttpsRequest(url: URL, init: RequestInit, addresses: ResolvedAddress[]): Promise<Response> {
  const pinned = addresses[0];
  if (!pinned?.address || net.isIP(pinned.address) === 0) {
    throw new Error(`目标 DNS 解析结果无效: ${String(pinned?.address)}`);
  }
  const headers = new Headers(init.headers);
  // Keep original hostname for virtual-hosted HTTPS endpoints.
  if (!headers.has("host") && !headers.has("Host")) headers.set("Host", url.host);
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
    throw new Error("安全出站请求仅支持可重放请求体");
  }

  // Connect directly to the validated public IP and keep SNI/servername as the
  // original hostname. Avoid custom dns.LookupFunction callbacks: Node may call
  // them with options.all=true, which makes callback(null, ip, family) turn into
  // "Invalid IP address: undefined".
  return new Promise<Response>((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      host: pinned.address,
      servername: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: init.method || "GET",
      headers: Object.fromEntries(headers.entries()),
      family: pinned.family,
      signal: init.signal || undefined,
    }, response => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach(item => responseHeaders.append(name, item));
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      resolve(new Response(Readable.toWeb(response) as ReadableStream, {
        status: response.statusCode || 500,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("出站请求超时")));
    request.on("error", reject);
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

export interface SafeOutboundFetchDependencies {
  resolver?: Resolver;
  transport?: (url: URL, init: RequestInit, addresses: ResolvedAddress[]) => Promise<Response>;
}

export async function safeOutboundFetch(
  input: string | URL,
  init: RequestInit,
  kind: OutboundUrlKind,
  dependencies: SafeOutboundFetchDependencies = {},
): Promise<Response> {
  let current = assertOutboundUrl(input.toString(), kind);
  let currentInit = { ...init, redirect: "manual" as const };
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const addresses = await resolveSafeAddresses(current, kind, dependencies.resolver);
    const response = await (dependencies.transport ?? pinnedHttpsRequest)(current, currentInit, addresses);
    const target = resolveRedirect(current, response.status, response.headers.get("location"), redirect);
    if (!target) {
      Object.defineProperty(response, "url", { configurable: true, value: current.toString() });
      return response;
    }

    await response.body?.cancel();
    assertUrlPolicy(target, kind);
    const headers = new Headers(currentInit.headers);
    if (target.origin !== current.origin) headers.delete("authorization");
    if ([301, 302, 303].includes(response.status) && (currentInit.method || "GET").toUpperCase() !== "GET") {
      headers.delete("content-type");
      currentInit = { ...currentInit, method: "GET", body: undefined, headers };
    } else {
      currentInit = { ...currentInit, headers };
    }
    current = target;
  }
  throw new Error("重定向次数超过限制");
}

async function readLimitedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("响应内容超过大小限制"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(result);
}

export async function safeFetchText(input: string): Promise<{ textContent: string; resolvedUrl: string }> {
  const response = await safeOutboundFetch(input, { headers: { "User-Agent": "Mozilla/5.0" } }, "fetch-url");
  if (!response.ok) throw new Error(`抓取失败: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (contentType && !/(json|text|javascript|octet-stream)/i.test(contentType)) throw new Error("响应内容类型不受支持");
  return { textContent: await readLimitedBody(response), resolvedUrl: response.url || input };
}
