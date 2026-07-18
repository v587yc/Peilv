import type { AdminPrincipal } from "@/lib/auth/admin-capabilities";
import { writeAuditLog } from "@/lib/audit-log";

export async function auditDeploymentRejection(input: {
  action: "deployment.preflight" | "deployment.deploy" | "deployment.rollback";
  principal: AdminPrincipal;
  requestId: string;
  error: string;
}): Promise<boolean> {
  return writeAuditLog({
    actorId: input.principal.actorId,
    actorType: "admin",
    action: `${input.action}.rejected`,
    objectType: "deployment",
    objectId: input.action,
    requestId: input.requestId,
    metadata: { error: input.error.slice(0, 500) },
  });
}
