import { describe,expect,it,vi } from "vitest";
import { NextRequest,type NextFetchEvent } from "next/server";
import { ADMIN_CAPABILITIES,principalForActor } from "@/lib/auth/admin-capabilities";
import { validateAdminPassword } from "@/lib/auth/password";
import { proxy } from "@/proxy";
describe("administrator RBAC and guardrails",()=>{
 it("maps all three roles to exact privilege tiers",()=>{expect(principalForActor({actorId:"s",actorType:"admin",role:"super_admin"}).capabilities).toEqual(ADMIN_CAPABILITIES);expect(principalForActor({actorId:"o",actorType:"admin",role:"operator"}).capabilities).toEqual(["admin:view","admin:configure","admin:execute"]);expect(principalForActor({actorId:"a",actorType:"admin",role:"auditor"}).capabilities).toEqual(["admin:view"])});
 it.each([["short1","密码至少需要 12 个字符"],["onlyletterslong","密码必须同时包含字母和数字"],["123456789012","密码必须同时包含字母和数字"],[`Valid1${"x".repeat(195)}`,"密码不能超过 200 个字符"]])("rejects weak password %s",(password,message)=>expect(validateAdminPassword(password)).toBe(message));
 it("keeps next redirect on a local admin path",async()=>{const event={waitUntil:vi.fn()} as unknown as NextFetchEvent;const response=await proxy(new NextRequest("https://app.invalid/admin/users?filter=%2F%2Fevil.invalid"),event);const location=new URL(response.headers.get("location")||"","https://app.invalid");expect(location.origin).toBe("https://app.invalid");expect(location.pathname).toBe("/login");expect(location.searchParams.get("next")).toBe("/admin/users?filter=%2F%2Fevil.invalid")});
});
