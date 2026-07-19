import { runIdSchema,strategyLabAdminGet } from "@/features/strategy-lab/admin-query-route";
import { StrategyLabQueryError } from "@/features/strategy-lab/admin-query-service";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return strategyLabAdminGet(request,async(service,requestId)=>{const parsed=runIdSchema.safeParse((await context.params).id);if(!parsed.success)throw new StrategyLabQueryError("validation");return service.matrix(requestId,parsed.data);});}
