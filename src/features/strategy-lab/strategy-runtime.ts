import type { StrategyId } from "./types";
import { z } from "zod";
import { strategyLabHashSchema } from "./policy-schemas";

const descriptorBase = {
  version: z.string().min(1), artifactHash: strategyLabHashSchema, schemaVersion: z.literal(1),
  engineVersion: z.string().min(1), codeCompatibility: z.string().min(1), behaviorCorpusHash: strategyLabHashSchema,
};
export const strategyADefinitionSchema=z.object({strategyId:z.literal("A"),version:z.string().min(1),executable:z.literal(true),deterministic:z.literal(true)}).strict();
export const strategyBDefinitionSchema=z.object({strategyId:z.literal("B"),version:z.string().min(1),executable:z.literal(true),deterministic:z.literal(true)}).strict();
export const strategyCDefinitionSchema=z.object({strategyId:z.literal("C"),version:z.string().min(1),executable:z.literal(true),fallback:z.literal("A"),completeWithoutExecutor:z.literal("unavailable")}).strict();
export const strategyDDefinitionSchema=z.object({strategyId:z.literal("D"),version:z.string().min(1),executable:z.literal(false),availability:z.literal("compatibility-only")}).strict();
export const strategyArtifactDescriptorSchema = z.discriminatedUnion("strategyId", [
  z.object({...descriptorBase,strategyId:z.literal("A"),executable:z.literal(true),definition:strategyADefinitionSchema}).strict(),
  z.object({...descriptorBase,strategyId:z.literal("B"),executable:z.literal(true),definition:strategyBDefinitionSchema}).strict(),
  z.object({...descriptorBase,strategyId:z.literal("C"),executable:z.literal(true),definition:strategyCDefinitionSchema}).strict(),
  z.object({...descriptorBase,strategyId:z.literal("D"),executable:z.literal(false),definition:strategyDDefinitionSchema}).strict(),
]);
export const strategyArtifactSetSchema = z.object({
  A: strategyArtifactDescriptorSchema.options[0], B: strategyArtifactDescriptorSchema.options[1],
  C: strategyArtifactDescriptorSchema.options[2], D: strategyArtifactDescriptorSchema.options[3],
}).strict().superRefine((value,context)=>{for(const id of ["A","B","C","D"] as const)if(value[id].definition.version!==value[id].version)context.addIssue({code:"custom",path:[id,"definition","version"],message:"definition version mismatch"});});

export type StrategyArtifactDescriptor = z.infer<typeof strategyArtifactDescriptorSchema>;

export interface StrategyArtifactRuntimeRegistry {
  resolve(input: {
    readonly descriptor: Readonly<StrategyArtifactDescriptor>;
    readonly runBuildId: string;
    readonly currentBuildId: string;
  }): boolean;
}

export function isStrategyArtifactDescriptor(value: unknown, strategyId?: StrategyId): value is StrategyArtifactDescriptor {
  const parsed=strategyArtifactDescriptorSchema.safeParse(value); return parsed.success&&(!strategyId||parsed.data.strategyId===strategyId);
}

export class BuiltInStrategyArtifactRuntimeRegistry implements StrategyArtifactRuntimeRegistry {
  constructor(private readonly supported: Readonly<Record<StrategyId, StrategyArtifactDescriptor>>) {}
  resolve(input: { descriptor: Readonly<StrategyArtifactDescriptor>; runBuildId: string; currentBuildId: string }): boolean {
    const expected = this.supported[input.descriptor.strategyId];
    return Boolean(expected && expected.executable && input.descriptor.executable
      && input.runBuildId === input.currentBuildId
      && expected.executable === input.descriptor.executable
      && expected.artifactHash === input.descriptor.artifactHash
      && expected.schemaVersion === input.descriptor.schemaVersion
      && expected.engineVersion === input.descriptor.engineVersion
      && expected.codeCompatibility === input.descriptor.codeCompatibility
      && expected.behaviorCorpusHash === input.descriptor.behaviorCorpusHash);
  }
}
