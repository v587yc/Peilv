import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("OpenResty administrator authentication contract", () => {
  it("uses non-empty address keys for strict and probe traffic", async () => {
    const config = await readFile(new URL("../infra/openresty/peilv.conf", import.meta.url), "utf8");
    expect(config).toMatch(/~\^\(POST\|DELETE\):\/api\/auth\/session\$ \$binary_remote_addr;/);
    expect(config).toMatch(/~\^POST:\/api\/auth\/bootstrap\$ \$binary_remote_addr;/);
    expect(config).toMatch(/~\^\(GET\|HEAD\):\/api\/auth\/session\$ \$binary_remote_addr;/);
    expect(config).toContain("zone=peilv_admin_auth_strict_rate");
    expect(config).toContain("zone=peilv_admin_auth_probe_rate");
    expect(config).toContain("limit_conn peilv_admin_auth_strict_conn 2;");
    expect(config).toContain("limit_conn peilv_admin_auth_probe_conn 10;");
  });

  it("rejects unsupported auth methods and terminates TLS", async () => {
    const config = await readFile(new URL("../infra/openresty/peilv.conf", import.meta.url), "utf8");
    expect(config.match(/return 405;/g)).toHaveLength(2);
    expect(config).toContain("listen 80;");
    expect(config).toContain("server_name __PEILV_PUBLIC_HOST__;");
    expect(config).toContain("return 301 https://__PEILV_PUBLIC_HOST__$request_uri;");
    expect(config).toContain("return 444;");
    expect(config).not.toContain("$host");
    expect(config).toContain("listen 443 ssl;");
    expect(config).toContain("ssl_certificate /etc/peilv/tls/fullchain.pem;");
    expect(config).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains" always;');
    expect(config).toContain("proxy_set_header X-Forwarded-Proto https;");
    expect(config).not.toContain("$proxy_add_x_forwarded_for");
  });

  it("provides a loopback-only secure-cookie deployment probe", async () => {
    const config = await readFile(new URL("../infra/openresty/peilv.conf", import.meta.url), "utf8");
    expect(config).toContain("location = /_ops/secure-cookie-probe");
    expect(config).toContain("allow 127.0.0.1;");
    expect(config).toContain("deny all;");
    expect(config).toContain("Secure; HttpOnly; SameSite=Strict");
  });
});
