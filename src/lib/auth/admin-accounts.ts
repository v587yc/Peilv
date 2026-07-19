import { randomUUID } from "node:crypto";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { hashAdminPassword, validateAdminPassword, verifyAdminPassword } from "./password";

export const ADMIN_ROLES = ["super_admin", "operator", "auditor"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export type AdminUser = {
  id: string;
  username: string;
  displayName: string;
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class AdminUserUpdateConflictError extends Error {
  constructor() {
    super("管理员数据已被其他操作更新");
    this.name = "AdminUserUpdateConflictError";
  }
}

type AdminUserRow = {
  id: string; username: string; display_name: string; password_hash: string; role: AdminRole;
  is_active: boolean; last_login_at: string | null; created_at: string; updated_at: string;
};

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;
let dummyPasswordHash: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= hashAdminPassword("DummyCredentialProbe-7f4d2c9a");
  return dummyPasswordHash;
}

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && ADMIN_ROLES.includes(value as AdminRole);
}

function publicUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id, username: row.username, displayName: row.display_name, role: row.role,
    isActive: row.is_active, lastLoginAt: row.last_login_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function countAdminUsers(): Promise<number> {
  const { count, error } = await getSupabaseClient().from("admin_users").select("id", { count: "exact", head: true });
  if (error) throw new Error("管理员数据暂时不可用");
  return count || 0;
}

export async function authenticateAdmin(username: unknown, password: unknown): Promise<AdminUser | null> {
  const normalized = normalizeUsername(username);
  if (typeof password !== "string") return null;
  if (!normalized || password.length > 200) {
    await verifyAdminPassword(password.slice(0, 200), await getDummyPasswordHash());
    return null;
  }
  const { data, error } = await getSupabaseClient().from("admin_users").select("*").eq("username", normalized).maybeSingle();
  if (error) throw new Error("管理员认证暂时不可用");
  const passwordMatches = await verifyAdminPassword(password, data?.password_hash || await getDummyPasswordHash());
  if (!data || !data.is_active || !passwordMatches) return null;
  await getSupabaseClient().from("admin_users").update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", data.id);
  return publicUser(data as AdminUserRow);
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const { data, error } = await getSupabaseClient().from("admin_users").select("id,username,display_name,role,is_active,last_login_at,created_at,updated_at").order("created_at");
  if (error) throw new Error("管理员列表暂时不可用");
  return (data || []).map(row => publicUser(row as AdminUserRow));
}

export async function getAdminUser(id: string): Promise<AdminUser | null> {
  const { data, error } = await getSupabaseClient().from("admin_users")
    .select("id,username,display_name,role,is_active,last_login_at,created_at,updated_at")
    .eq("id", id).maybeSingle();
  if (error) throw new Error("管理员数据暂时不可用");
  return data ? publicUser(data as AdminUserRow) : null;
}

export async function createAdminUser(input: { username: unknown; displayName?: unknown; password: string; role: AdminRole; actorId: string; requestId: string }): Promise<AdminUser> {
  const username = normalizeUsername(input.username);
  if (!username) throw new Error("账号需为 3-64 位字母、数字、点、下划线或短横线");
  const passwordError = validateAdminPassword(input.password);
  if (passwordError) throw new Error(passwordError);
  const displayName = typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim().slice(0, 100) : username;
  const { data, error } = await getSupabaseClient().rpc("create_admin_user_audited", {
    p_id: randomUUID(), p_username: username, p_display_name: displayName,
    p_password_hash: await hashAdminPassword(input.password), p_role: input.role,
    p_actor_id: input.actorId, p_request_id: input.requestId,
  });
  if (error) throw new Error("管理员创建事务失败");
  const outcome = data as { ok?: boolean; error_code?: string; user?: AdminUserRow } | null;
  if (!outcome?.ok || !outcome.user) {
    if (outcome?.error_code === "ADMIN_ALREADY_EXISTS") throw new Error("管理员账号已存在");
    throw new Error("创建管理员失败");
  }
  return publicUser(outcome.user);
}

export async function bootstrapFirstAdmin(input: { username: unknown; displayName?: unknown; password: string }): Promise<AdminUser> {
  const username = normalizeUsername(input.username);
  if (!username) throw new Error("账号需为 3-64 位字母、数字、点、下划线或短横线");
  const passwordError = validateAdminPassword(input.password);
  if (passwordError) throw new Error(passwordError);
  const displayName = typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim().slice(0, 100) : username;
  const { data, error } = await getSupabaseClient().rpc("bootstrap_first_admin", {
    p_id: randomUUID(), p_username: username, p_display_name: displayName,
    p_password_hash: await hashAdminPassword(input.password),
  });
  if (error) {
    if (error.message?.includes("ADMIN_ALREADY_INITIALIZED")) throw new Error("管理员已初始化");
    throw new Error("初始化管理员失败");
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("初始化管理员失败");
  return publicUser(row as AdminUserRow);
}

export async function updateAdminUser(id: string, expectedUpdatedAt: string, changes: { displayName?: string; role?: AdminRole; isActive?: boolean; password?: string }, audit: { actorId: string; requestId: string }): Promise<AdminUser> {
  let passwordHash: string | null = null;
  if (changes.password !== undefined) {
    const passwordError = validateAdminPassword(changes.password);
    if (passwordError) throw new Error(passwordError);
    passwordHash = await hashAdminPassword(changes.password);
  }
  const { data, error } = await getSupabaseClient().rpc("update_admin_user_audited", {
    p_id: id,
    p_expected_updated_at: expectedUpdatedAt,
    p_display_name: changes.displayName === undefined ? null : changes.displayName.trim().slice(0, 100),
    p_role: changes.role ?? null,
    p_is_active: changes.isActive ?? null,
    p_password_hash: passwordHash,
    p_actor_id: audit.actorId,
    p_request_id: audit.requestId,
  });
  if (error) {
    throw new Error("管理员更新失败");
  }
  const outcome = data as { ok?: boolean; error_code?: string; user?: AdminUserRow } | null;
  if (!outcome?.ok || !outcome.user) {
    if (outcome?.error_code === "ADMIN_UPDATE_CONFLICT") throw new AdminUserUpdateConflictError();
    if (outcome?.error_code === "LAST_ACTIVE_SUPER_ADMIN") throw new Error("不能停用或降级最后一个超级管理员");
    if (outcome?.error_code === "ADMIN_NOT_FOUND") throw new Error("管理员不存在");
    throw new Error("管理员更新失败");
  }
  return publicUser(outcome.user);
}
