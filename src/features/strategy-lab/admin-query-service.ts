import "server-only";
import { deepFreeze } from "./normalization";
import { ADMIN_QUERY_CONTRACT_VERSION, type QueryEnvelope } from "./admin-query-contracts";
import { AdminQueryCursorError, adminQueryFilterHash, type AdminQueryCursorCodec } from "./admin-query-cursor";
import type { PageRequest, PredictionFilters, RunFilters, RunScopedFilters, SettlementFilters, StrategyLabAdminQueryRepository } from "./admin-query-repository";

export class StrategyLabQueryError extends Error { constructor(readonly code:"validation"|"not_found"|"integrity"|"unavailable"){super(code)} }
export class StrategyLabAdminQueryService {
 constructor(private readonly repository:StrategyLabAdminQueryRepository,private readonly cursors:AdminQueryCursorCodec,private readonly now=()=>new Date()){}
 private envelope<T>(requestId:string,filters:Record<string,unknown>,data:T,pageInfo:QueryEnvelope<T>["pageInfo"]=null):Readonly<QueryEnvelope<T>> {return deepFreeze({contractVersion:ADMIN_QUERY_CONTRACT_VERSION,generatedAt:this.now().toISOString(),requestId,appliedFilters:filters,pageInfo,data}) as Readonly<QueryEnvelope<T>>;}
 private async page<T extends {id:string;createdAt:string},F extends Record<string,unknown>>(input:{requestId:string;collection:string;filters:F&{sort:"created_desc"|"created_asc"};limit:number;cursor?:string},load:(request:PageRequest<F&{sort:"created_desc"|"created_asc"}>)=>Promise<readonly T[]>) {const boundFilters={collection:input.collection,...input.filters};const hash=adminQueryFilterHash(boundFilters);let cursor;if(input.cursor){cursor=this.cursors.decode(input.cursor);if(cursor.filterHash!==hash||cursor.sort!==input.filters.sort)throw new AdminQueryCursorError("filter_mismatch");}const rows=await load({filters:input.filters,limit:input.limit+1,cursor});const hasMore=rows.length>input.limit;const data=rows.slice(0,input.limit);const last=data.at(-1);const nextCursor=hasMore&&last?this.cursors.encode({contractVersion:ADMIN_QUERY_CONTRACT_VERSION,sort:input.filters.sort,lastCreatedAt:last.createdAt,lastId:last.id,filterHash:hash}):null;return this.envelope(input.requestId,input.filters,data,{limit:input.limit,hasMore,nextCursor});}
 async runs(input:{requestId:string;filters:RunFilters;limit:number;cursor?:string}) {return this.page({...input,collection:"runs"},request=>this.repository.listRuns(request));}
 async overview(requestId:string,runId:string){const data=await this.repository.runOverview(runId);if(!data)throw new StrategyLabQueryError("not_found");return this.envelope(requestId,{runId},data);}
 async matrix(requestId:string,runId:string){const data=await this.repository.runMatrix(runId);if(!data)throw new StrategyLabQueryError("not_found");if(data.length!==12)throw new StrategyLabQueryError("integrity");return this.envelope(requestId,{runId},data);}
 async report(requestId:string,runId:string){const data=await this.repository.runReport(runId);if(!data)throw new StrategyLabQueryError("not_found");return this.envelope(requestId,{runId},data);}
 async snapshots(input:{requestId:string;filters:RunScopedFilters;limit:number;cursor?:string}){return this.page({...input,collection:"snapshots"},request=>this.repository.listSnapshots(request));}
 async predictions(input:{requestId:string;filters:PredictionFilters;limit:number;cursor?:string}){return this.page({...input,collection:"predictions"},request=>this.repository.listPredictions(request));}
 async settlements(input:{requestId:string;filters:SettlementFilters;limit:number;cursor?:string}){return this.page({...input,collection:"settlements"},request=>this.repository.listSettlements(request));}
 async chain(requestId:string,predictionId:string){const data=await this.repository.settlementChain(predictionId);if(!data)throw new StrategyLabQueryError("not_found");return this.envelope(requestId,{predictionId},data);}
 async audit(input:{requestId:string;filters:RunScopedFilters;limit:number;cursor?:string}){const result=await this.page({...input,collection:"audit"},request=>this.repository.runAudit(request).then(rows=>{if(!rows)throw new StrategyLabQueryError("not_found");return rows;}));return result;}
}
