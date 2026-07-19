import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { requestIdFor, safeErrorResponse } from "@/lib/api/safe-error-response";
import { AdminQueryCursorError } from "./admin-query-cursor";
import { StrategyLabQueryError } from "./admin-query-service";
import { getStrategyLabAdminQueryService } from "./admin-query-server";

const headers={"Cache-Control":"private, no-store"};
export const runIdSchema=z.string().uuid();
export const requiredRunIdQuerySchema=z.object({runId:z.string().uuid()}).strict();
export const pageQueryFields={sort:z.enum(["created_desc","created_asc"]).default("created_desc"),limit:z.coerce.number().int().min(1).max(200).default(50),cursor:z.string().max(2048).optional()} as const;
export const runScopedPageQuerySchema=z.object({runId:z.string().uuid(),...pageQueryFields}).strict();
const date=z.string().regex(/^\d{8}$/);
export const runQuerySchema=z.object({status:z.enum(["pending","running","succeeded","failed","cancelled"]).optional(),runType:z.enum(["shadow","backtest","manual"]).optional(),from:date.optional(),to:date.optional(),q:z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}\s._:-]+$/u).optional(),...pageQueryFields}).strict().superRefine((v,ctx)=>{if(v.from&&v.to){const start=Date.UTC(+v.from.slice(0,4),+v.from.slice(4,6)-1,+v.from.slice(6));const end=Date.UTC(+v.to.slice(0,4),+v.to.slice(4,6)-1,+v.to.slice(6));if(end<start||end-start>90*86400000)ctx.addIssue({code:"custom",message:"Date range must be within 90 days"});}});

export async function strategyLabAdminGet(request:Request,execute:(service:NonNullable<ReturnType<typeof getStrategyLabAdminQueryService>>,requestId:string)=>Promise<unknown>){const requestId=requestIdFor(request);const auth=await requireAdminCapability(request,"admin:view");if(!auth.ok)return safeErrorResponse({requestId,status:auth.status,errorCode:auth.status===401?"ADMIN_AUTH_REQUIRED":auth.status===403?"ADMIN_PERMISSION_DENIED":"ADMIN_AUTH_UNAVAILABLE",message:auth.error});const service=getStrategyLabAdminQueryService();if(!service)return safeErrorResponse({requestId,status:503,errorCode:"STRATEGY_LAB_QUERY_UNAVAILABLE",message:"Strategy Lab read service is unavailable"});try{return NextResponse.json(await execute(service,requestId),{headers:{...headers,"x-request-id":requestId}});}catch(error){if(error instanceof AdminQueryCursorError)return safeErrorResponse({requestId,status:400,errorCode:error.reason==="filter_mismatch"?"CURSOR_FILTER_MISMATCH":"INVALID_CURSOR",message:"Invalid query cursor"});if(error instanceof StrategyLabQueryError){const map={validation:[400,"INVALID_QUERY"],not_found:[404,"STRATEGY_LAB_NOT_FOUND"],integrity:[422,"STRATEGY_LAB_INTEGRITY_ERROR"],unavailable:[503,"STRATEGY_LAB_QUERY_UNAVAILABLE"]} as const;const [status,code]=map[error.code];return safeErrorResponse({requestId,status,errorCode:code,message:error.code==="not_found"?"Strategy Lab record was not found":error.code==="integrity"?"Strategy Lab evidence is inconsistent":"Strategy Lab query failed"});}if(error&&typeof error==="object"&&(error as {code?:unknown}).code==="integrity_error")return safeErrorResponse({requestId,status:422,errorCode:"STRATEGY_LAB_INTEGRITY_ERROR",message:"Strategy Lab evidence is inconsistent"});return safeErrorResponse({requestId,status:503,errorCode:"STRATEGY_LAB_QUERY_UNAVAILABLE",message:"Strategy Lab read service is unavailable"});}}
export function parseSearch<T>(request:Request,schema:z.ZodType<T>):T{const values=Object.fromEntries(new URL(request.url).searchParams.entries());const result=schema.safeParse(values);if(!result.success)throw new StrategyLabQueryError("validation");return result.data;}
