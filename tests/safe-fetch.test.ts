import { afterEach, describe, expect, it } from "vitest";
import {
  assertUrlPolicy,
  isAllowedHost,
  isPrivateIp,
  resolveRedirect,
} from "@/lib/safe-fetch";

const originalAllowedHosts = process.env.FETCH_URL_ALLOWED_HOSTS;

afterEach(() => {
  if (originalAllowedHosts === undefined) {
    delete process.env.FETCH_URL_ALLOWED_HOSTS;
  } else {
    process.env.FETCH_URL_ALLOWED_HOSTS = originalAllowedHosts;
  }
});

describe("SSRF URL policy", () => {
  it("allows built-in hosts and their subdomains only", () => {
    expect(isAllowedHost("coze.cn")).toBe(true);
    expect(isAllowedHost("api.coze.cn")).toBe(true);
    expect(isAllowedHost("coze.cn.")).toBe(true);
    expect(isAllowedHost("evilcoze.cn")).toBe(false);
    expect(isAllowedHost("example.com")).toBe(false);
  });

  it("honors normalized configured hosts", () => {
    process.env.FETCH_URL_ALLOWED_HOSTS = " Example.COM, api.test.invalid ";
    expect(isAllowedHost("example.com")).toBe(true);
    expect(isAllowedHost("sub.example.com")).toBe(true);
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
    expect(() => assertUrlPolicy(new URL("https://localhost/path"))).toThrow("目标域名不在允许列表中");
    expect(() => assertUrlPolicy(new URL("https://example.com/path"))).toThrow("目标域名不在允许列表中");
    expect(() => assertUrlPolicy(new URL("https://user:pass@coze.cn/path"))).toThrow("URL 不允许包含凭据");
    expect(() => assertUrlPolicy(new URL("http://coze.cn/path"))).toThrow("仅允许访问 HTTPS 地址");
    expect(() => assertUrlPolicy(new URL("https://coze.cn/path"))).not.toThrow();
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
});
