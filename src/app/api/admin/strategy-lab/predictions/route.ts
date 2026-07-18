import { strategyLabWriteRoute } from "@/features/strategy-lab/admin-route";
import { pageQueryFields, parseSearch, strategyLabAdminGet } from "@/features/strategy-lab/admin-query-route";
import { z } from "zod";
const query=z.object({runId:z.string().uuid(),q:z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}\s._:-]+$/u).optional(),strategy:z.enum(["A","B","C","D"]).optional(),checkpoint:z.enum(["T1215","T30","T03"]).optional(),status:z.enum(["recommend","observe","reanalyze_required","insufficient_data"]).optional(),...pageQueryFields}).strict();
export async function GET(request:Request){return strategyLabAdminGet(request,(service,requestId)=>{const{limit,cursor,...filters}=parseSearch(request,query);return service.predictions({requestId,filters,limit,cursor});});}
export async function POST(request: Request) { return strategyLabWriteRoute(request, { capability: "admin:execute", action: "strategy-lab.prediction.execute", objectType: "strategy_lab_prediction", execute: (service, body, actor) => service.executeStrategy(body as never, actor) }); }
