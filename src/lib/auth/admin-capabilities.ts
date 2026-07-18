import { authorizeAdminRequest, type AdminActor } from "@/lib/admin-auth";
import type { AdminRole } from "./admin-accounts";

export const ADMIN_CAPABILITIES = ["admin:view", "admin:configure", "admin:execute", "admin:dangerous", "admin:manage"] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];
export type AdminPrincipal = AdminActor & { capabilities: readonly AdminCapability[] };
export type CapabilityAuthorization = { ok: true; principal: AdminPrincipal } | { ok: false; status: 401 | 403 | 503; error: string };

export const ROLE_CAPABILITIES: Record<AdminRole, readonly AdminCapability[]> = {
  super_admin: ADMIN_CAPABILITIES,
  operator: ["admin:view", "admin:configure", "admin:execute"],
  auditor: ["admin:view"],
};

export function isAdminCapability(value: unknown): value is AdminCapability { return typeof value === "string" && ADMIN_CAPABILITIES.includes(value as AdminCapability); }
export function principalForActor(actor: AdminActor): AdminPrincipal {
  return { ...actor, capabilities: actor.actorType === "admin" && actor.role ? ROLE_CAPABILITIES[actor.role] : [] };
}
export function hasAdminCapability(principal: AdminPrincipal, capability: unknown): capability is AdminCapability {
  return isAdminCapability(capability) && principal.capabilities.includes(capability);
}
export async function requireAdminCapability(request: Request, capability: unknown): Promise<CapabilityAuthorization> {
  const authorization = await authorizeAdminRequest(request); if (!authorization.ok) return authorization;
  const principal = principalForActor(authorization.actor);
  return hasAdminCapability(principal, capability) ? { ok: true, principal } : { ok: false, status: 403, error: "权限不足" };
}
