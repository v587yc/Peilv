import { describe,expect,it,vi } from "vitest";
import { canonicalLeagueSet,leaguePolicyHash,normalizeLeagueName } from "@/features/strategy-lab/policy-schemas";
import { PostgresLeaguePolicy } from "@/features/strategy-lab/postgres-league-policy";

describe("league policy normalization",()=>{
  it("normalizes NFC and whitespace without aliases",()=>{
    expect(normalizeLeagueName("  英  超 \n")).toBe("英 超");
    expect(normalizeLeagueName(" Cafe\u0301 League ")).toBe("Café League");
    expect(canonicalLeagueSet(["西甲"," 英超 ","英超"])).toEqual(["英超","西甲"]);
  });
  it("hashes sets independent of order and duplication but changes on membership",()=>{
    expect(leaguePolicyHash(["英超","西甲"])).toBe(leaguePolicyHash([" 西甲 ","英超","英超"]));
    expect(leaguePolicyHash(["英超"])).not.toBe(leaguePolicyHash(["英超","西甲"]));
    expect(()=>leaguePolicyHash([])).toThrow();
  });
});

describe("PostgresLeaguePolicy",()=>{
  const captureId="10000000-0000-4000-8000-000000000001";
  const bound={matchId:"m1",matchDate:"20260717",policyArtifactHash:"a".repeat(64),policyCaptureId:captureId,datasetCutoffAt:"2026-07-17T12:00Z"};
  const client=(responses: unknown[][])=>({query:vi.fn(),transaction:vi.fn(async(callback:(tx:{query:ReturnType<typeof vi.fn>})=>Promise<unknown>)=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.startsWith("SET TRANSACTION")?[]:responses.shift()??[]})); return callback({query});
  })});
  it("allows exact bound policy/fact and denies nonmembers",async()=>{
    const yes=client([[{leagues:["英超"]}],[{league_name_normalized:"英超"}]]); const policy=new PostgresLeaguePolicy(yes as never);
    await expect(policy.allows(bound)).resolves.toBe(true);
    const no=client([[{leagues:["西甲"]}],[{league_name_normalized:"英超"}]]); await expect(new PostgresLeaguePolicy(no as never).allows(bound)).resolves.toBe(false);
  });
  it.each<unknown[]>([[],[{league_name_normalized:"英超"},{league_name_normalized:"西甲"}]])("fails closed for absent/conflicting match facts",async facts=>{
    const db=client([[{leagues:["英超"]}],facts as unknown[]]); await expect(new PostgresLeaguePolicy(db as never).allows(bound)).rejects.toThrow(/unavailable/);
  });
  it("does not read the mutable whitelist while authorizing an old run",async()=>{
    const db=client([[{leagues:["英超"]}],[{league_name_normalized:"英超"}]]); await new PostgresLeaguePolicy(db as never).allows(bound);
    const calls=(db.transaction.mock.calls[0][0] as unknown); expect(calls).toBeTypeOf("function");
  });
});
