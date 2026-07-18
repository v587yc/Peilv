import { strategyLabWriteRoute } from "@/features/strategy-lab/admin-route";
import { parseSearch, runQuerySchema, strategyLabAdminGet } from "@/features/strategy-lab/admin-query-route";
export async function GET(request:Request){return strategyLabAdminGet(request,(service,requestId)=>{const {limit,cursor,...filters}=parseSearch(request,runQuerySchema);return service.runs({requestId,filters,limit,cursor});});}
export async function POST(request: Request) { return strategyLabWriteRoute(request, { capability: "admin:configure", action: "strategy-lab.run.create", objectType: "strategy_lab_run", execute: (service, body, actor) => service.createRun(body as never, actor) }); }
