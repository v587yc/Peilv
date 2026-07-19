import { VersionUpdateView } from "../_components/version-update-view";
import { AdminCapabilityGate } from "../_components/admin-capability-gate";
import { ADMIN_PAGE_CAPABILITIES } from "../_components/admin-page-access";
export default function Page(){return <AdminCapabilityGate required={ADMIN_PAGE_CAPABILITIES["/admin/deployments"]}><VersionUpdateView/></AdminCapabilityGate>;}
