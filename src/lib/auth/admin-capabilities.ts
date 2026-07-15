import { authorizeAdminRequest, type AdminActor } from "@/lib/admin-auth";

export const ADMIN_CAPABILITIES = [
  "admin:view",
  "admin:configure",
  "admin:execute",
  "admin:dangerous",
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

export type AdminPrincipal = AdminActor & {
  capabilities: readonly AdminCapability[];
};

export type CapabilityAuthorization =
  | { ok: true; principal: AdminPrincipal }
  | { ok: false; status: 401 | 403 | 503; error: string };

export function isAdminCapability(value: unknown): value is AdminCapability {
  return typeof value === "string" && ADMIN_CAPABILITIES.some(capability => capability === value);
}

export function principalForActor(actor: AdminActor): AdminPrincipal {
  return {
    ...actor,
    capabilities: actor.actorType === "admin" ? ADMIN_CAPABILITIES : [],
  };
}

export function hasAdminCapability(
  principal: AdminPrincipal,
  capability: unknown,
): capability is AdminCapability {
  return isAdminCapability(capability) && principal.capabilities.includes(capability);
}

export function requireAdminCapability(
  request: Request,
  capability: unknown,
): CapabilityAuthorization {
  const authorization = authorizeAdminRequest(request);
  if (!authorization.ok) return authorization;

  const principal = principalForActor(authorization.actor);
  if (!hasAdminCapability(principal, capability)) {
    return { ok: false, status: 403, error: "权限不足" };
  }
  return { ok: true, principal };
}
