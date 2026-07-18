import { AdminCapabilityGate } from "../../_components/admin-capability-gate";
import { ADMIN_PAGE_CAPABILITIES } from "../../_components/admin-page-access";
import { StrategyLabView } from "./strategy-lab-view";
export default function Page(){return <AdminCapabilityGate required={ADMIN_PAGE_CAPABILITIES["/admin/strategies/lab"]}><StrategyLabView/></AdminCapabilityGate>;}
