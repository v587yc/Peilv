import { describe,expect,it,vi } from "vitest";
import { PostgresStrategyLabAdminQueryRepository } from "@/features/strategy-lab/postgres-admin-query-repository";
import type { QuerySqlClient } from "@/features/strategy-lab/admin-query-repository";
const id="10000000-0000-4000-8000-000000000001";
function client(rows:readonly Record<string,unknown>[]=[]){
  const query=vi.fn(async(sql:string,parameters:readonly unknown[]=[]):Promise<{rows:readonly Record<string,unknown>[]}>=>{
    void sql;void parameters;return{rows};
  });
  const executor={query:query as QuerySqlClient["query"]};
  const sql:QuerySqlClient={...executor,transaction:async callback=>callback(executor)};
  return{sql,query};
}
describe("Strategy Lab read-only SQL repository",()=>{it("uses allowlisted sort, parameters, and stable tuple cursor",async()=>{const {sql,query}=client();const repo=new PostgresStrategyLabAdminQueryRepository(sql);await repo.listRuns({filters:{status:"running",q:"shadow",sort:"created_desc"},limit:51,cursor:{contractVersion:"read-v1",sort:"created_desc",lastCreatedAt:"2026-07-01T00:00:00.000Z",lastId:id,filterHash:"a".repeat(64)}});const call=query.mock.calls[0]!;const statement=call[0],parameters=call[1]!;expect(statement).toContain("row_number() OVER");expect(statement).toContain("ORDER BY r.created_at DESC,r.id DESC");expect(statement).not.toContain("shadow");expect(parameters).toContain("%shadow%");expect(parameters.at(-1)).toBe(51);});
it("creates all 12 cells and keeps C fallback/D baseline semantics",async()=>{const {sql,query}=client();query.mockResolvedValueOnce({rows:[{id}]}).mockResolvedValueOnce({rows:[{requested_strategy:"C",checkpoint_type:"T30",sample:2,fallback:1,actual_counted:0,actual_profit_micros:"0",theoretical_counted:0,theoretical_profit_micros:"0"}]});const cells=await new PostgresStrategyLabAdminQueryRepository(sql).runMatrix(id);expect(cells).toHaveLength(12);expect(cells?.find(x=>x.strategy==="C"&&x.checkpoint==="T30")?.fallback).toBe(1);expect(cells?.find(x=>x.strategy==="D")?.executable).toBe(false);expect(query.mock.calls[1]![0]).toContain("p.source='d_compat_shadow'");expect(query.mock.calls[1]![0]).toContain("row_number() OVER");});});
