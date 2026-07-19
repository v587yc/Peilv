import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { StrategyLabVersionProvider, StrategyLabVersionSnapshot } from "./application-service";
import type { StrategyLabSqlClient } from "./postgres-repository";
import { PostgresLeaguePolicy, StrategyLabPolicyUnavailableError } from "./postgres-league-policy";
import { BUILT_IN_STRATEGY_ARTIFACTS, STRATEGY_LAB_BEHAVIOR_CORPUS_HASH, STRATEGY_LAB_CODE_COMPATIBILITY, STRATEGY_LAB_ENGINE_VERSION } from "./strategy-artifacts";
import { stableStrategyJson } from "./normalization";
import type { StrategyId } from "./types";
import type { TrustedBuildIdentityProvider } from "./trusted-build-identity";
import { strategyArtifactSetSchema } from "./strategy-runtime";

export class StrategyLabVersionUnavailableError extends Error { constructor() { super("Strategy laboratory version dependency unavailable"); this.name="StrategyLabVersionUnavailableError"; } }
interface ArtifactRow extends Record<string,unknown> { strategy_id:StrategyId;version:string;artifact_hash:string;engine_version:string;code_compatibility:string;behavior_corpus_hash:string;schema_version:number;definition:unknown;executable:boolean }

export class PostgresStrategyLabVersionProvider implements StrategyLabVersionProvider {
  constructor(private readonly client:StrategyLabSqlClient,private readonly policy:PostgresLeaguePolicy,private readonly buildLookupKey:string|undefined,private readonly trustedBuild:TrustedBuildIdentityProvider) {}
  async load(input:{datasetCutoffAt:string;createdBy:string;traceId:string}):Promise<Readonly<StrategyLabVersionSnapshot>> {
    if (!this.buildLookupKey) throw new StrategyLabVersionUnavailableError();
    const cutoff=new Date(input.datasetCutoffAt); if(!Number.isFinite(cutoff.valueOf())) throw new StrategyLabVersionUnavailableError();
    try {
      const trusted=await this.trustedBuild.load(this.buildLookupKey);
      return await this.client.transaction(async tx=>{
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const builds=await tx.query<{build_id:string;manifest_digest:string;commit_sha:string;release_id:string;artifact_digest:string;compatibility:string}>("SELECT build_id,manifest_digest,commit_sha,release_id,artifact_digest,compatibility FROM strategy_lab_build_artifacts WHERE build_id=$1",[trusted.buildId]);
        const build=builds.rows[0]; if(builds.rows.length!==1||build.manifest_digest!==trusted.manifestDigest||build.commit_sha!==trusted.commitSha||build.release_id!==trusted.releaseId||build.artifact_digest!==trusted.archiveSha256||build.compatibility!==STRATEGY_LAB_CODE_COMPATIBILITY) throw new StrategyLabVersionUnavailableError();
        const rows=await tx.query<ArtifactRow>(`WITH eligible AS (SELECT p.*,a.strategy_id,ROW_NUMBER() OVER(PARTITION BY a.strategy_id ORDER BY p.effective_from DESC,p.revision DESC) rank FROM strategy_lab_strategy_publications p JOIN strategy_lab_strategy_artifacts a ON a.artifact_hash=p.artifact_hash WHERE p.published_at<=$1 AND p.effective_from<=$1 AND (p.effective_to IS NULL OR p.effective_to>$1)), active AS (SELECT * FROM eligible WHERE rank=1 AND status='published') SELECT a.strategy_id,a.version,a.artifact_hash,a.engine_version,a.code_compatibility,a.behavior_corpus_hash,a.schema_version,a.definition,a.executable FROM strategy_lab_strategy_artifacts a JOIN active p ON p.artifact_hash=a.artifact_hash ORDER BY a.strategy_id`,[cutoff.toISOString()]);
        if(rows.rows.length!==4||new Set(rows.rows.map(row=>row.strategy_id)).size!==4) throw new StrategyLabVersionUnavailableError();
        for(const row of rows.rows){const canonical={schemaVersion:row.schema_version,engineVersion:row.engine_version,codeCompatibility:row.code_compatibility,behaviorCorpusHash:row.behavior_corpus_hash,definition:row.definition};const computed=createHash("sha256").update(stableStrategyJson(canonical)).digest("hex");if(row.artifact_hash!==computed||row.schema_version!==1||row.engine_version!==STRATEGY_LAB_ENGINE_VERSION||row.code_compatibility!==STRATEGY_LAB_CODE_COMPATIBILITY||row.behavior_corpus_hash!==STRATEGY_LAB_BEHAVIOR_CORPUS_HASH) throw new StrategyLabVersionUnavailableError();}
        const candidate=Object.fromEntries(rows.rows.map(row=>[row.strategy_id,{strategyId:row.strategy_id,version:row.version,artifactHash:row.artifact_hash,engineVersion:row.engine_version,codeCompatibility:row.code_compatibility,behaviorCorpusHash:row.behavior_corpus_hash,schemaVersion:row.schema_version,definition:row.definition,executable:row.executable}]));
        const parsed=strategyArtifactSetSchema.safeParse(candidate); if(!parsed.success) throw new StrategyLabVersionUnavailableError();
        const strategyVersions=parsed.data;
        const leaguePolicy=await this.policy.captureWithExecutor(tx,input);
        return Object.freeze({codeVersion:trusted.buildId,strategyVersions:Object.freeze(strategyVersions),leaguePolicy});
      });
    } catch(error){ if(error instanceof StrategyLabVersionUnavailableError) throw error; if(error instanceof StrategyLabPolicyUnavailableError) throw new StrategyLabVersionUnavailableError(); throw new StrategyLabVersionUnavailableError(); }
  }
}

export async function registerBuiltInStrategyArtifacts(input:{client:StrategyLabSqlClient;effectiveFrom:string;createdBy:string;traceId:string}):Promise<void>{
  const effective=new Date(input.effectiveFrom); if(!Number.isFinite(effective.valueOf())) throw new StrategyLabVersionUnavailableError();
  await input.client.transaction(async tx=>{ for(const strategyId of ["A","B","C","D"] as const){ const artifact=BUILT_IN_STRATEGY_ARTIFACTS[strategyId]; const payload={schemaVersion:artifact.schemaVersion,engineVersion:artifact.engineVersion,codeCompatibility:artifact.codeCompatibility,behaviorCorpusHash:artifact.behaviorCorpusHash,definition:artifact.definition}; const existing=await tx.query<{artifact_hash:string}>("SELECT artifact_hash FROM strategy_lab_strategy_artifacts WHERE strategy_id=$1 AND version=$2",[strategyId,artifact.version]); if(existing.rows.length&&existing.rows[0].artifact_hash!==artifact.artifactHash) throw new StrategyLabVersionUnavailableError(); await tx.query(`INSERT INTO strategy_lab_strategy_artifacts(strategy_id,version,artifact_hash,engine_version,definition,canonical_payload,code_compatibility,schema_version,behavior_corpus_hash,executable,created_by,trace_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12) ON CONFLICT(artifact_hash) DO NOTHING`,[strategyId,artifact.version,artifact.artifactHash,artifact.engineVersion,JSON.stringify(artifact.definition),JSON.stringify(payload),artifact.codeCompatibility,artifact.schemaVersion,artifact.behaviorCorpusHash,artifact.executable,input.createdBy,input.traceId]); const publications=await tx.query<{artifact_hash:string}>(`WITH latest AS(SELECT DISTINCT ON(root_id) artifact_hash,status FROM strategy_lab_strategy_publications ORDER BY root_id,revision DESC) SELECT artifact_hash FROM latest WHERE artifact_hash=$1 AND status='published'`,[artifact.artifactHash]); if(!publications.rows.length) await tx.query(`INSERT INTO strategy_lab_strategy_publications(id,root_id,artifact_hash,status,effective_from,revision,published_at,actor,trace_id) VALUES($1,$1,$2,'published',$3,1,$3,$4,$5)`,[randomUUID(),artifact.artifactHash,effective.toISOString(),input.createdBy,input.traceId]); }});
}
