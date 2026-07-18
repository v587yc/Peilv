import { strategyLabWriteRoute } from "@/features/strategy-lab/admin-route";
import { createSettlementApplicationSchema } from "@/features/strategy-lab/application-schemas";
import { pageQueryFields, parseSearch, strategyLabAdminGet } from "@/features/strategy-lab/admin-query-route";
import { z } from "zod";
const query=z.object({runId:z.string().uuid(),history:z.enum(["true","false"]).default("false"),quoteBasis:z.enum(["actual","theoretical"]).optional(),...pageQueryFields}).strict().transform(value=>({...value,history:value.history==="true"}));
export async function GET(request:Request){return strategyLabAdminGet(request,(service,requestId)=>{const{limit,cursor,...filters}=parseSearch(request,query);return service.settlements({requestId,filters,limit,cursor});});}
export async function POST(request: Request) { return strategyLabWriteRoute(request, { capability: "admin:dangerous", action: "strategy-lab.settlement.create", objectType: "strategy_lab_settlement", validateBody: body => createSettlementApplicationSchema.safeParse(body), execute: (service, body, actor) => service.createSettlement(body as never, actor) }); }
