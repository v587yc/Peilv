import { GovernanceView } from "../_components/governance-view";
import { AdminCapabilityGate } from "../_components/admin-capability-gate";
import { ADMIN_PAGE_CAPABILITIES } from "../_components/admin-page-access";
export default function Page() { return <AdminCapabilityGate required={ADMIN_PAGE_CAPABILITIES["/admin/sources"]}>{principal => <GovernanceView kind="sources" capabilities={principal.capabilities} />}</AdminCapabilityGate>; }
