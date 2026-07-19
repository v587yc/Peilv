import { createHash } from "node:crypto";
import { describe,expect,it } from "vitest";
import { stableStrategyJson } from "@/features/strategy-lab/normalization";
import { canonicalLeagueSet, leagueHistoryEvidenceHash, normalizeLeagueName } from "@/features/strategy-lab/policy-schemas";
import { BUILT_IN_STRATEGY_ARTIFACTS,STRATEGY_LAB_BEHAVIOR_CORPUS,STRATEGY_LAB_BEHAVIOR_CORPUS_HASH } from "@/features/strategy-lab/strategy-artifacts";
import { evaluateStrategyA } from "@/features/strategy-lab/strategy-a";
import { evaluateStrategyB } from "@/features/strategy-lab/strategy-b";
import { evaluateStrategyC } from "@/features/strategy-lab/strategy-c";
import { createCanonicalMatchFact } from "@/features/strategy-lab/match-fact";
import { BuiltInStrategyArtifactRuntimeRegistry,strategyArtifactSetSchema } from "@/features/strategy-lab/strategy-runtime";

const NORMALIZATION_GOLDEN_HASH="c24c5df201a96af22610d139443af3a0a3f3d8c34106557ac8996c05d78bb7c2";
describe("Phase2 frozen golden evidence",()=>{
 it("freezes NFC, whitespace and UTF8 ordering vectors",()=>{const output={normalized:normalizeLeagueName(" \tCafe\u0301\u00a0\u202f\u3000联赛\r\n "),ordered:canonicalLeagueSet(["西甲","英超"," Cafe\u0301 "])};expect(output).toEqual({normalized:"Café 联赛",ordered:["Café","英超","西甲"]});expect(createHash("sha256").update(stableStrategyJson(output)).digest("hex")).toBe(NORMALIZATION_GOLDEN_HASH);});
 it("hashes canonical history evidence independent of order and changes on content",()=>{const event=(id:string,action:"add"|"remove")=>({id,contentHash:(id==="a"?"a":"b").repeat(64),action,league:id==="a"?"英超":"西甲",source:"admin",sourceObservedAt:"2026-07-17T10:00:00.000Z",revision:1});const base={schemaVersion:1 as const,baseline:{id:"10000000-0000-4000-8000-000000000001",contentHash:"c".repeat(64),completedAt:"2026-07-17T10:00:00.000Z",sourceObservedAt:"2026-07-17T10:00:00.000Z"},datasetCutoffAt:"2026-07-17T12:00:00.000Z"};expect(leagueHistoryEvidenceHash({...base,events:[event("a","add"),event("b","add")]})).toBe(leagueHistoryEvidenceHash({...base,events:[event("b","add"),event("a","add")]}));expect(leagueHistoryEvidenceHash({...base,events:[event("a","add")]})).not.toBe(leagueHistoryEvidenceHash({...base,events:[event("a","remove")]}));});
 it("uses a fixed behavior corpus hash and matches A B C decisions",()=>{expect(createHash("sha256").update(stableStrategyJson(STRATEGY_LAB_BEHAVIOR_CORPUS)).digest("hex")).toBe(STRATEGY_LAB_BEHAVIOR_CORPUS_HASH);for(const vector of STRATEGY_LAB_BEHAVIOR_CORPUS.A)expect(evaluateStrategyA(vector.input).decision).toEqual(vector.expected);for(const vector of STRATEGY_LAB_BEHAVIOR_CORPUS.B)expect(evaluateStrategyB(vector.input).decision).toEqual(vector.expected);for(const vector of STRATEGY_LAB_BEHAVIOR_CORPUS.C){const result=evaluateStrategyC(vector.input);expect({decision:result.decision,executedStrategy:result.meta.executedStrategy,availability:result.cMeta.availability,fallbackReason:result.cMeta.fallbackReason,missingFields:result.cMeta.missingFields}).toEqual(vector.expected);}expect(BUILT_IN_STRATEGY_ARTIFACTS.D.executable).toBe(false);});
 it("creates canonical match facts only through server factory",()=>{const fact=createCanonicalMatchFact({id:"10000000-0000-4000-8000-000000000009",matchId:"m1",matchDate:"20260717",leagueNameRaw:" Cafe\u0301　联赛 ",kickoffAt:"2026-07-17T15:00Z",source:"schedule",sourceObservedAt:"2026-07-17T10:00Z",datasetCutoffAt:"2026-07-17T12:00Z",revision:1,supersedesId:null,traceId:"t"});expect(fact.leagueNameNormalized).toBe("Café 联赛");expect(fact.contentHash).toMatch(/^[0-9a-f]{64}$/);});
 it("strictly validates definitions and every artifact runtime compatibility dimension",()=>{
  expect(strategyArtifactSetSchema.parse(BUILT_IN_STRATEGY_ARTIFACTS)).toEqual(BUILT_IN_STRATEGY_ARTIFACTS);
  expect(()=>strategyArtifactSetSchema.parse({...BUILT_IN_STRATEGY_ARTIFACTS,A:{...BUILT_IN_STRATEGY_ARTIFACTS.A,schemaVersion:2}})).toThrow();
  expect(()=>strategyArtifactSetSchema.parse({...BUILT_IN_STRATEGY_ARTIFACTS,A:{...BUILT_IN_STRATEGY_ARTIFACTS.A,definition:{...BUILT_IN_STRATEGY_ARTIFACTS.A.definition,deterministic:false}}})).toThrow();
  const registry=new BuiltInStrategyArtifactRuntimeRegistry(BUILT_IN_STRATEGY_ARTIFACTS);
  const resolve=(descriptor:typeof BUILT_IN_STRATEGY_ARTIFACTS.A,runBuildId="build",currentBuildId="build")=>registry.resolve({descriptor,runBuildId,currentBuildId});
  expect(resolve(BUILT_IN_STRATEGY_ARTIFACTS.A)).toBe(true);
  expect(resolve(BUILT_IN_STRATEGY_ARTIFACTS.A,"old","current")).toBe(false);
  expect(resolve({...BUILT_IN_STRATEGY_ARTIFACTS.A,artifactHash:"f".repeat(64)})).toBe(false);
  expect(resolve({...BUILT_IN_STRATEGY_ARTIFACTS.A,engineVersion:"other"})).toBe(false);
  expect(resolve({...BUILT_IN_STRATEGY_ARTIFACTS.A,schemaVersion:2 as 1})).toBe(false);
  expect(resolve({...BUILT_IN_STRATEGY_ARTIFACTS.A,codeCompatibility:"other"})).toBe(false);
  expect(resolve({...BUILT_IN_STRATEGY_ARTIFACTS.A,behaviorCorpusHash:"e".repeat(64)})).toBe(false);
  expect(registry.resolve({descriptor:BUILT_IN_STRATEGY_ARTIFACTS.D,runBuildId:"build",currentBuildId:"build"})).toBe(false);
 });
});
