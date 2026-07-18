import { AdminUsersView } from "../_components/admin-users-view";
import { AdminCapabilityGate } from "../_components/admin-capability-gate";
import { ADMIN_PAGE_CAPABILITIES } from "../_components/admin-page-access";

export default function AdminAccountsPage() {
  return <AdminCapabilityGate required={ADMIN_PAGE_CAPABILITIES["/admin/admins"]}><AdminUsersView /></AdminCapabilityGate>;
}
