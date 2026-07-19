import { AccessManagementView } from "../_components/access-management-view";
import { AdminCapabilityGate } from "../_components/admin-capability-gate";
import { ADMIN_PAGE_CAPABILITIES } from "../_components/admin-page-access";

export default function AdminRolesPage() {
  return <AdminCapabilityGate required={ADMIN_PAGE_CAPABILITIES["/admin/roles"]}><AccessManagementView kind="roles" /></AdminCapabilityGate>;
}
