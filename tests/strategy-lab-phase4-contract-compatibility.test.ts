import { describe, expect, it } from "vitest";
import { createStrategyLabPredictionSchema } from "@/features/strategy-lab/persistence-schemas";

const base={id:"10000000-0000-4000-8000-000000000001",runId:"10000000-0000-4000-8000-000000000002",snapshotSetId:"10000000-0000-4000-8000-000000000003",matchId:"m1",matchDate:"20260717",checkpointType:"T1215",requestedStrategy:"A",executedStrategy:"A",strategyVersion:"A-v1",selection:"home",decisionStatus:"recommend",lockedDeterministic:true,reasonCode:"ok",branchId:"b",inputHash:"i",outputHash:"o",decisionPayload:{current:null,previousEffective:null,waterDiffBasisPoints:null,details:{}},fallbackReason:null,legacyPredictionId:null,source:"experiment",idempotencyKey:"k",traceId:"t"};
const physical={executionCutoffAt:"2026-07-17T12:15:00.000Z",executedActualQuoteSnapshotId:7,theoreticalHandicapRaw:"半球",theoreticalHandicapQuarterUnits:2,theoreticalSelectedWater:"0.900000"};

describe("Phase4 v1 compatibility and v2 strict evidence",()=>{
  it("reads a legacy v1 prediction with no physical evidence",()=>expect(createStrategyLabPredictionSchema.safeParse({...base,evidenceContractVersion:1}).success).toBe(true));
  it.each(Object.keys(physical) as (keyof typeof physical)[])("rejects v1 carrying %s",key=>expect(createStrategyLabPredictionSchema.safeParse({...base,evidenceContractVersion:1,[key]:physical[key]}).success).toBe(false));
  it.each(Object.keys(physical) as (keyof typeof physical)[])("rejects v2 recommendation missing %s",key=>{const candidate={...base,...physical,evidenceContractVersion:2} as Record<string,unknown>;candidate[key]=null;expect(createStrategyLabPredictionSchema.safeParse(candidate).success).toBe(false)});
  it("accepts complete v2 recommendation",()=>expect(createStrategyLabPredictionSchema.safeParse({...base,...physical,evidenceContractVersion:2}).success).toBe(true));
  it.each(Object.keys(physical) as (keyof typeof physical)[])("rejects v2 nonrecommend carrying %s",key=>expect(createStrategyLabPredictionSchema.safeParse({...base,selection:null,decisionStatus:"skip",evidenceContractVersion:2,[key]:physical[key]}).success).toBe(false));
});
