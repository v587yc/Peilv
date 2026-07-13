import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDeploymentLoginFailures,
  createDeploymentCsrfToken,
  createDeploymentSession,
  getTrustedDeploymentOrigin,
  isDeploymentLoginBlocked,
  isSameOriginDeploymentMutation,
  normalizeDeploymentUsername,
  recordDeploymentLoginFailure,
  resetDeploymentLoginThrottleForTests,
  verifyDeploymentCredentials,
  verifyDeploymentCsrfToken,
  verifyDeploymentSession,
} from "@/lib/deployment-auth";

const salt = Buffer.from("0123456789abcdef", "utf8");
const password = "Correct-Horse-Battery-Staple!";
const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const passwordHash = `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
const original = {
  session: process.env.DEPLOYMENT_SESSION_SECRET,
  username: process.env.DEPLOYMENT_ADMIN_USERNAME,
  passwordHash: process.env.DEPLOYMENT_ADMIN_PASSWORD_HASH,
  origin: process.env.DEPLOYMENT_PUBLIC_ORIGIN,
};

beforeEach(() => {
  process.env.DEPLOYMENT_SESSION_SECRET = "s".repeat(32);
  process.env.DEPLOYMENT_ADMIN_USERNAME = "admin";
  process.env.DEPLOYMENT_ADMIN_PASSWORD_HASH = passwordHash;
  delete process.env.DEPLOYMENT_PUBLIC_ORIGIN;
  resetDeploymentLoginThrottleForTests();
});

afterEach(() => {
  for (const [name, value] of Object.entries({
    DEPLOYMENT_SESSION_SECRET: original.session,
    DEPLOYMENT_ADMIN_USERNAME: original.username,
    DEPLOYMENT_ADMIN_PASSWORD_HASH: original.passwordHash,
    DEPLOYMENT_PUBLIC_ORIGIN: original.origin,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetDeploymentLoginThrottleForTests();
});

describe("deployment credentials", () => {
  it("normalizes the configured username and verifies scrypt credentials", async () => {
    expect(normalizeDeploymentUsername(" Admin ")).toBe("admin");
    expect(await verifyDeploymentCredentials("ADMIN", password)).toBe("valid");
    expect(await verifyDeploymentCredentials("other", password)).toBe("invalid");
    expect(await verifyDeploymentCredentials("admin", "wrong")).toBe("invalid");
  });

  it("fails closed for malformed configuration", async () => {
    process.env.DEPLOYMENT_ADMIN_PASSWORD_HASH = "invalid";
    expect(await verifyDeploymentCredentials("admin", password)).toBe("unconfigured");
  });
});

describe("deployment session", () => {
  it("issues a signed local session and action-bound CSRF token", () => {
    const now = Date.now();
    const session = createDeploymentSession("admin", now);
    const actor = verifyDeploymentSession(session, now);
    expect(actor).toMatchObject({ actorId: "local:admin", username: "admin" });
    expect(session).not.toContain(password);
    const csrf = createDeploymentCsrfToken(actor!, "deploy");
    expect(verifyDeploymentCsrfToken(actor!, "deploy", csrf)).toBe(true);
    expect(verifyDeploymentCsrfToken(actor!, "rollback", csrf)).toBe(false);
    expect(verifyDeploymentSession(`${session.slice(0, -1)}x`, now)).toBeNull();
  });

  it("rejects renamed users and expired sessions", () => {
    const now = Date.now();
    const session = createDeploymentSession("admin", now);
    process.env.DEPLOYMENT_ADMIN_USERNAME = "other-admin";
    expect(verifyDeploymentSession(session, now)).toBeNull();
    process.env.DEPLOYMENT_ADMIN_USERNAME = "admin";
    expect(verifyDeploymentSession(session, now + 9 * 60 * 60 * 1000)).toBeNull();
  });
});

describe("deployment login throttling", () => {
  it("blocks after five failures and clears after reset", () => {
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) recordDeploymentLoginFailure("admin", "127.0.0.1", now + index);
    expect(isDeploymentLoginBlocked("admin", "127.0.0.1", now + 10)).toBe(true);
    expect(isDeploymentLoginBlocked("admin", "127.0.0.2", now + 10)).toBe(false);
    clearDeploymentLoginFailures("admin", "127.0.0.1");
    expect(isDeploymentLoginBlocked("admin", "127.0.0.1", now + 10)).toBe(false);
  });

  it("allows retries after the block expires", () => {
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) recordDeploymentLoginFailure("admin", "127.0.0.1", now);
    expect(isDeploymentLoginBlocked("admin", "127.0.0.1", now + 16 * 60 * 1000)).toBe(false);
  });
});

describe("trusted deployment origin", () => {
  it("uses the configured canonical HTTPS origin for redirects and mutations", () => {
    process.env.DEPLOYMENT_PUBLIC_ORIGIN = "https://pb.aixid.cc";
    const request = new Request("http://localhost:5000/deployments", {
      method: "POST",
      headers: { Origin: "https://pb.aixid.cc", Host: "localhost:5000", "x-forwarded-host": "pb.aixid.cc", "x-forwarded-proto": "https" },
    });
    expect(getTrustedDeploymentOrigin(request).origin).toBe("https://pb.aixid.cc");
    expect(isSameOriginDeploymentMutation(request)).toBe(true);
  });

  it("rejects an attacker-controlled origin", () => {
    process.env.DEPLOYMENT_PUBLIC_ORIGIN = "https://pb.aixid.cc";
    const request = new Request("http://localhost:5000/deployments", {
      method: "POST",
      headers: { Origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    });
    expect(getTrustedDeploymentOrigin(request).origin).toBe("https://pb.aixid.cc");
    expect(isSameOriginDeploymentMutation(request)).toBe(false);
  });
});
