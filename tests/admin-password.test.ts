import { describe, expect, it } from "vitest";
import { hashAdminPassword, validateAdminPassword, verifyAdminPassword } from "@/lib/auth/password";

describe("admin password hashing", () => {
  it("uses salted scrypt hashes and verifies only the correct password", async () => {
    const first = await hashAdminPassword("StrongPassword123");
    const second = await hashAdminPassword("StrongPassword123");
    expect(first).toMatch(/^scrypt\$v=1\$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("StrongPassword123");
    expect(await verifyAdminPassword("StrongPassword123", first)).toBe(true);
    expect(await verifyAdminPassword("WrongPassword123", first)).toBe(false);
  });
  it("enforces the minimum password policy", () => {
    expect(validateAdminPassword("short1")).toBeTruthy();
    expect(validateAdminPassword("onlyletterslong")).toBeTruthy();
    expect(validateAdminPassword("ValidPassword123")).toBeNull();
  });
  it.each(["Password123!", "Admin123456!!", "Qwerty123456!"])("rejects common password %s", password => {
    expect(validateAdminPassword(password)).toBe("密码过于常见，请使用更强的密码");
  });
});
