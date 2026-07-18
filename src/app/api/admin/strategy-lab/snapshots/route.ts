import { strategyLabWriteRoute } from "@/features/strategy-lab/admin-route";
import { parseSearch, runScopedPageQuerySchema, strategyLabAdminGet } from "@/features/strategy-lab/admin-query-route";
export async function GET(request:Request){return strategyLabAdminGet(request,(service,requestId)=>{const{limit,cursor,...filters}=parseSearch(request,runScopedPageQuerySchema);return service.snapshots({requestId,filters,limit,cursor});});}
export async function POST(request: Request) { return strategyLabWriteRoute(request, { capability: "admin:configure", action: "strategy-lab.snapshot.capture", objectType: "strategy_lab_snapshot", execute: (service, body, actor) => service.captureSnapshotSet(body as never, actor) }); }
