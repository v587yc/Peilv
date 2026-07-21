import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOutboundUrl,
  assertUrlPolicy,
  isAllowedHost,
  isPrivateIp,
  resolveSafeAddresses,
  resolveRedirect,
  safeOutboundFetch,
} from "@/lib/safe-fetch";

const originalAllowedHosts = process.env.FETCH_URL_ALLOWED_HOSTS;
const originalAdminHosts = process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS;
const originalAdminPorts = process.env.ADMIN_OUTBOUND_ALLOWED_PORTS;

afterEach(() => {
  if (originalAllowedHosts === undefined) {
    delete process.env.FETCH_URL_ALLOWED_HOSTS;
  } else {
    process.env.FETCH_URL_ALLOWED_HOSTS = originalAllowedHosts;
  }
  if (originalAdminHosts === undefined) delete process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS;
  else process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = originalAdminHosts;
  if (originalAdminPorts === undefined) delete process.env.ADMIN_OUTBOUND_ALLOWED_PORTS;
  else process.env.ADMIN_OUTBOUND_ALLOWED_PORTS = originalAdminPorts;
  vi.restoreAllMocks();
});

describe("SSRF URL policy", () => {
  it("allows built-in exact hosts without implicitly trusting subdomains", () => {
    expect(isAllowedHost("coze.cn")).toBe(true);
    expect(isAllowedHost("api.coze.cn")).toBe(false);
    expect(isAllowedHost("coze.cn.")).toBe(true);
    expect(isAllowedHost("evilcoze.cn")).toBe(false);
    expect(isAllowedHost("example.com")).toBe(false);
  });

  it("honors normalized configured hosts", () => {
    process.env.FETCH_URL_ALLOWED_HOSTS = " Example.COM, *.test.invalid ";
    expect(isAllowedHost("example.com")).toBe(true);
    expect(isAllowedHost("sub.example.com")).toBe(false);
    expect(isAllowedHost("api.test.invalid")).toBe(true);
    expect(isAllowedHost("test.invalid")).toBe(false);
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.1.1",
    "::ffff:7f00:1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "2001:db8::1",
  ])("blocks private or special address %s", (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"])(
    "recognizes public address %s",
    (address) => {
      expect(isPrivateIp(address)).toBe(false);
    },
  );

  it("rejects localhost, non-allowlisted, credentialed, and non-HTTPS URLs", () => {
    expect(() => assertUrlPolicy(new URL("https://localhost/path"))).toThrow("本地主机名");
    expect(() => assertUrlPolicy(new URL("https://example.com/path"))).toThrow("目标域名不在允许列表中");
    expect(() => assertUrlPolicy(new URL("https://user:pass@coze.cn/path"))).toThrow("URL 不允许包含凭据");
    expect(() => assertUrlPolicy(new URL("http://coze.cn/path"))).toThrow("仅允许访问 HTTPS 地址");
    expect(() => assertUrlPolicy(new URL("https://coze.cn/path#secret"))).toThrow("fragment");
    expect(() => assertUrlPolicy(new URL("https://coze.cn:8443/path"))).toThrow("目标端口不在允许列表中");
    expect(() => assertUrlPolicy(new URL("https://coze.cn/path"))).not.toThrow();
  });

  it.each([
    "https://127.0.0.1/path",
    "https://[::1]/path",
    "https://2130706433/path",
    "https://0x7f000001/path",
  ])("rejects literal and confusing IP URL %s", input => {
    process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = "127.0.0.1,::1";
    expect(() => assertOutboundUrl(input, "llm")).toThrow("IP 字面量");
  });

  it("allows an explicitly approved custom endpoint and port", () => {
    process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = "llm.example.invalid";
    process.env.ADMIN_OUTBOUND_ALLOWED_PORTS = "8443";
    expect(() => assertOutboundUrl("https://llm.example.invalid:8443/v1", "llm")).not.toThrow();
  });

  it("rejects localhost even if an administrator tries to allow it", () => {
    process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = "localhost";
    expect(() => assertOutboundUrl("https://localhost/v1", "llm")).toThrow("本地主机名");
  });

  it("rejects a hostname when any A or AAAA answer is unsafe", async () => {
    process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = "mixed.example.invalid";
    await expect(resolveSafeAddresses(new URL("https://mixed.example.invalid/v1"), "llm", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::1", family: 6 },
    ])).rejects.toThrow("不可访问地址");
  });
});

describe("redirect policy", () => {
  const current = new URL("https://coze.cn/a/page");

  it("ignores non-redirect responses", () => {
    expect(resolveRedirect(current, 200, "/next", 0)).toBeNull();
  });

  it("resolves relative redirect targets without network access", () => {
    expect(resolveRedirect(current, 302, "../next", 0)?.toString()).toBe("https://coze.cn/next");
  });

  it("requires a location and limits redirects", () => {
    expect(() => resolveRedirect(current, 302, null, 0)).toThrow("重定向缺少目标地址");
    expect(() => resolveRedirect(current, 302, "/next", 3)).toThrow("重定向次数超过限制");
  });

  it("revalidates DNS and policy on every redirect hop", async () => {
    process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = "public.example.invalid,redirect.example.invalid";
    const resolver = vi.fn(async (hostname: string) => hostname === "redirect.example.invalid"
      ? [{ address: "10.0.0.7", family: 4 as const }]
      : [{ address: "93.184.216.34", family: 4 as const }]);
    const transport = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://redirect.example.invalid/internal" },
    }));

    await expect(safeOutboundFetch("https://public.example.invalid/start", {}, "llm", {
      resolver,
      transport,
    })).rejects.toThrow("不可访问地址");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("pins transport to one address only after validating every DNS answer", async () => {
    process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = "api.example.invalid";
    const addresses = [
      { address: "93.184.216.34", family: 4 as const },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 as const },
    ];
    const transport = vi.fn(async (_url, _init, resolved) => {
      expect(resolved).toEqual(addresses);
      return new Response("ok", { status: 200 });
    });
    await expect(safeOutboundFetch("https://api.example.invalid/v1", {}, "llm", {
      resolver: async () => addresses,
      transport,
    })).resolves.toBeInstanceOf(Response);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("uses pinned IP connection without custom lookup callbacks", async () => {
    process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = "aigpbt.top";
    const response = await safeOutboundFetch(
      "https://aigpbt.top/v1/models",
      { method: "GET", headers: { "User-Agent": "peilv-test" } },
      "llm",
      {
        resolver: async () => [{ address: "1.1.1.1", family: 4 }],
        transport: async (url, _init, addresses) => {
          expect(addresses[0]?.address).toBe("1.1.1.1");
          expect(addresses[0]?.family).toBe(4);
          return new Response(JSON.stringify({ ok: true, host: url.hostname }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ host: "aigpbt.top" });
  });

});
