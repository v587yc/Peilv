import { OverviewView } from "./_components/overview-view";
import { AdminCapabilityGate } from "./_components/admin-capability-gate";
import { ADMIN_PAGE_CAPABILITIES } from "./_components/admin-page-access";
export default function AdminOverviewPage(){return <AdminCapabilityGate required={ADMIN_PAGE_CAPABILITIES["/admin"]}><OverviewView/></AdminCapabilityGate>;}
