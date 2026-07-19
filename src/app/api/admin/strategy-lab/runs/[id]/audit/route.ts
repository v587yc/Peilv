import { pageQueryFields,parseSearch,runIdSchema,strategyLabAdminGet } from "@/features/strategy-lab/admin-query-route";
import { StrategyLabQueryError } from "@/features/strategy-lab/admin-query-service";
import { z } from "zod";
const query=z.object(pageQueryFields).strict();
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return strategyLabAdminGet(request,async(service,requestId)=>{const parsed=runIdSchema.safeParse((await context.params).id);if(!parsed.success)throw new StrategyLabQueryError("validation");const{limit,cursor,...page}=parseSearch(request,query);return service.audit({requestId,filters:{runId:parsed.data,...page},limit,cursor});});}
