import { afterEach, describe, expect, it } from "vitest";
import { loginAdmissionKeys, trustedLoginSourceIp } from "@/lib/auth/admin-login-rate-limit";
const originalSecret=process.env.ADMIN_LOGIN_RATE_LIMIT_SECRET;const originalTrust=process.env.ADMIN_TRUST_PROXY;
afterEach(()=>{if(originalSecret===undefined)delete process.env.ADMIN_LOGIN_RATE_LIMIT_SECRET;else process.env.ADMIN_LOGIN_RATE_LIMIT_SECRET=originalSecret;if(originalTrust===undefined)delete process.env.ADMIN_TRUST_PROXY;else process.env.ADMIN_TRUST_PROXY=originalTrust;});
describe("administrator login reservation keys",()=>{
 it("produces the same admission keys regardless of account input",()=>{process.env.ADMIN_LOGIN_RATE_LIMIT_SECRET="a-secure-test-secret-with-at-least-32-characters";const request=new Request("https://app.invalid");expect(loginAdmissionKeys(request)).toEqual(loginAdmissionKeys(request));expect(Object.keys(loginAdmissionKeys(request)).sort()).toEqual(["globalKey","sourceKey"])});
 it("does not expose a raw reservation token field",async()=>{process.env.ADMIN_LOGIN_RATE_LIMIT_SECRET="a-secure-test-secret-with-at-least-32-characters";const keys=loginAdmissionKeys(new Request("https://app.invalid"));expect(keys.globalKey).toMatch(/^[a-f0-9]{64}$/);expect(keys.sourceKey).toBeNull()});
 it("trusts source headers only behind an explicit trusted proxy",()=>{const request=new Request("https://app.invalid",{headers:{"x-forwarded-for":"203.0.113.7, 10.0.0.2"}});delete process.env.ADMIN_TRUST_PROXY;expect(trustedLoginSourceIp(request)).toBeNull();process.env.ADMIN_TRUST_PROXY="true";expect(trustedLoginSourceIp(request)).toBe("203.0.113.7")});
});
