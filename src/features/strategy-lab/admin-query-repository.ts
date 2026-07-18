import type { MatrixCell, RunListItem } from "./admin-query-contracts";
import type { AdminQueryCursorPayload } from "./admin-query-cursor";

export interface QuerySqlExecutor { query<Row extends Record<string,unknown>>(sql:string,parameters?:readonly unknown[]):Promise<{readonly rows:readonly Row[]}> }
export interface QuerySqlClient extends QuerySqlExecutor { transaction<T>(callback:(tx:QuerySqlExecutor)=>Promise<T>,options:{readOnly:true;isolationLevel:"repeatable read"}):Promise<T> }
export type RunFilters={status?:string;runType?:string;from?:string;to?:string;q?:string;sort:"created_desc"|"created_asc"};
export type CollectionSort="created_desc"|"created_asc";
export type PageRequest<Filters extends Record<string,unknown>>={filters:Filters;limit:number;cursor?:AdminQueryCursorPayload};
export type RunScopedFilters={runId:string;sort:CollectionSort};
export type PredictionFilters=RunScopedFilters&{q?:string;strategy?:"A"|"B"|"C"|"D";checkpoint?:"T1215"|"T30"|"T03";status?:string};
export type SettlementFilters=RunScopedFilters&{history:boolean;quoteBasis?:"actual"|"theoretical"};
export type PagedQueryItem=Record<string,unknown>&{id:string;createdAt:string};
export interface StrategyLabAdminQueryRepository {
 listRuns(input:PageRequest<RunFilters>):Promise<readonly RunListItem[]>;
 runOverview(runId:string):Promise<Record<string,unknown>|null>;
 runMatrix(runId:string):Promise<readonly MatrixCell[]|null>;
 runReport(runId:string):Promise<Record<string,unknown>|null>;
 listSnapshots(input:PageRequest<RunScopedFilters>):Promise<readonly PagedQueryItem[]>;
 listPredictions(input:PageRequest<PredictionFilters>):Promise<readonly PagedQueryItem[]>;
 listSettlements(input:PageRequest<SettlementFilters>):Promise<readonly PagedQueryItem[]>;
 settlementChain(predictionId:string):Promise<Record<string,unknown>|null>;
 runAudit(input:PageRequest<RunScopedFilters>):Promise<readonly PagedQueryItem[]|null>;
}
