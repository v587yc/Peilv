import "server-only";
import { createAdminQueryCursorCodec, type AdminQueryCursorCodec } from "./admin-query-cursor";
import { StrategyLabAdminQueryService } from "./admin-query-service";
import type { QuerySqlClient, StrategyLabAdminQueryRepository } from "./admin-query-repository";
import { PostgresStrategyLabAdminQueryRepository } from "./postgres-admin-query-repository";
import { getOrCreateStrategyLabPgOwner } from "./postgres-sql-client";

let testOverride:StrategyLabAdminQueryService|null|undefined;
let productionService:StrategyLabAdminQueryService|null|undefined;

export function createStrategyLabAdminQueryService(input:{sqlClient:QuerySqlClient;cursorCodec:AdminQueryCursorCodec;repository?:StrategyLabAdminQueryRepository}) {
  return new StrategyLabAdminQueryService(input.repository??new PostgresStrategyLabAdminQueryRepository(input.sqlClient),input.cursorCodec);
}
export function getStrategyLabAdminQueryService():StrategyLabAdminQueryService|null {
  if(process.env.NODE_ENV==="test"&&testOverride!==undefined)return testOverride;
  if(productionService!==undefined)return productionService;
  const databaseUrl=process.env.STRATEGY_LAB_READER_DATABASE_URL?.trim();
  const secret=process.env.ADMIN_QUERY_CURSOR_SECRET?.trim();
  if(!databaseUrl||!secret){productionService=null;return null;}
  try {const sqlClient=getOrCreateStrategyLabPgOwner({databaseUrl,ca:process.env.STRATEGY_LAB_READER_DATABASE_CA,maxConnections:4}).client;productionService=createStrategyLabAdminQueryService({sqlClient,cursorCodec:createAdminQueryCursorCodec(secret)});}
  catch {productionService=null;}
  return productionService;
}
export function registerStrategyLabAdminQueryServiceForTests(service:StrategyLabAdminQueryService|null){if(process.env.NODE_ENV!=="test")throw new Error("test-only query service registration");const previous=testOverride;testOverride=service;return()=>{testOverride=previous;};}
