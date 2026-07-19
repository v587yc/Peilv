import { createHash } from "node:crypto";
import { deepFreeze, stableStrategyJson } from "./normalization";
import type { StrategyEvaluationInput } from "./types";
import { strategyArtifactSetSchema, type StrategyArtifactDescriptor } from "./strategy-runtime";

export const STRATEGY_LAB_ENGINE_VERSION = "strategy-lab-engine-v1";
export const STRATEGY_LAB_CODE_COMPATIBILITY = "strategy-lab-phase2-v2";

const base = (checkpoint: StrategyEvaluationInput["checkpoint"], homeWater: string, awayWater: string, handicap = "半球"): StrategyEvaluationInput => ({ checkpoint, current: { homeWater, awayWater, handicap } });
const cMissing = { ...base("T1215", "0.90", "0.98"), cData: { marketConsensus: null, liquidityProfile: "normal", teamContext: "known" } } as const;
const cComplete = { ...base("T1215", "0.90", "0.98"), cData: { marketConsensus: "known", liquidityProfile: "normal", teamContext: "known" } } as const;

export const STRATEGY_LAB_BEHAVIOR_CORPUS = deepFreeze({
  schemaVersion: 1,
  A: [
    { input: base("T1215", "0.9000", "0.9399"), expected: {status:"observe",side:null,reasonCode:"A_DIFF_BELOW_004",branchId:"A-OBSERVE-DIFF-LT-004",lockedByDeterministicRule:true} },
    { input: base("T1215", "0.90", "0.98"), expected: {status:"recommend",side:"home",reasonCode:"A_MID_DIFF_HIGH_WATER_AT_MOST_1_SELECT_LOW",branchId:"A-RECOMMEND-MID-LOW-WATER",lockedByDeterministicRule:true} },
    { input: { ...base("T30", "0.90", "1.11"), previousEffective: { handicap: "半球" } }, expected: {status:"recommend",side:"away",reasonCode:"A_DIFF_ABOVE_020_SELECT_HIGH",branchId:"A-RECOMMEND-LARGE-DIFF-HIGH-WATER",lockedByDeterministicRule:true} },
  ],
  B: [
    { input: base("T1215", "0.90", "0.9399"), expected: {status:"observe",side:null,reasonCode:"B_DIFF_BELOW_004",branchId:"B-OBSERVE-DIFF-LT-004",lockedByDeterministicRule:true} },
    { input: base("T1215", "0.90", "0.94"), expected: {status:"recommend",side:"home",reasonCode:"B_DIFF_AT_LEAST_004_SELECT_LOW",branchId:"B-RECOMMEND-LOW-WATER",lockedByDeterministicRule:true} },
  ],
  C: [
    { input: cMissing, expected: {decision:{status:"recommend",side:"home",reasonCode:"A_MID_DIFF_HIGH_WATER_AT_MOST_1_SELECT_LOW",branchId:"A-RECOMMEND-MID-LOW-WATER",lockedByDeterministicRule:true},executedStrategy:"A",availability:"fallback",fallbackReason:"missing_critical_data",missingFields:["marketConsensus"]} },
    { input: cComplete, expected: {decision:{status:"insufficient_data",side:null,reasonCode:"C_EXECUTOR_UNAVAILABLE",branchId:"C-UNAVAILABLE-NOT-IMPLEMENTED",lockedByDeterministicRule:false},executedStrategy:"C",availability:"unavailable",fallbackReason:null,missingFields:[]} },
  ],
  D: [],
});

export const STRATEGY_LAB_BEHAVIOR_CORPUS_HASH = "285ba1135d08bd9c294d6f38ed32029502579aaad2be0ba6a7c81169ead885c5";

const definitions = {
  A: { strategyId: "A", version: "A-v1", executable: true, deterministic: true },
  B: { strategyId: "B", version: "B-v1", executable: true, deterministic: true },
  C: { strategyId: "C", version: "C-v1", executable: true, fallback: "A", completeWithoutExecutor: "unavailable" },
  D: { strategyId: "D", version: "D-v1", executable: false, availability: "compatibility-only" },
} as const;

function descriptor<T extends typeof definitions[keyof typeof definitions]>(definition:T):StrategyArtifactDescriptor {
  const hashInput = { schemaVersion: 1, engineVersion: STRATEGY_LAB_ENGINE_VERSION, codeCompatibility: STRATEGY_LAB_CODE_COMPATIBILITY, behaviorCorpusHash: STRATEGY_LAB_BEHAVIOR_CORPUS_HASH, definition };
  return strategyArtifactSetSchema.shape[definition.strategyId].parse({ strategyId:definition.strategyId,version:definition.version,executable:definition.executable,artifactHash: createHash("sha256").update(stableStrategyJson(hashInput)).digest("hex"), engineVersion: STRATEGY_LAB_ENGINE_VERSION, codeCompatibility: STRATEGY_LAB_CODE_COMPATIBILITY, behaviorCorpusHash: STRATEGY_LAB_BEHAVIOR_CORPUS_HASH, schemaVersion: 1, definition });
}
export const BUILT_IN_STRATEGY_ARTIFACTS = deepFreeze(strategyArtifactSetSchema.parse({A:descriptor(definitions.A),B:descriptor(definitions.B),C:descriptor(definitions.C),D:descriptor(definitions.D)}));
