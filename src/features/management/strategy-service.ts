import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_MODEL_VERSION, generateStrategyVersion, normalizeIndicatorWeights } from "@/lib/analysis/strategy";

type StrategySnapshot = { version:string; status:string; effective_from?:string|null; published_at?:string|null; retired_at?:string|null; model_config?:Record<string,unknown> };
type PatternSnapshot = { id?:number; pattern_key?:string; strategy_version?:string|null; status:string; published_at?:string|null; retired_at?:string|null };
let publicationQueue: Promise<void> = Promise.resolve();

export class StrategyGovernanceService {
  constructor(private readonly client: SupabaseClient) {}

  async createDraft(payload: Record<string, unknown>, actorId: string) {
    if (typeof payload.name !== "string" || payload.name.trim().length < 2) throw new Error("策略名称至少 2 个字符");
    const version = generateStrategyVersion();
    const row = { version, name: payload.name.trim(), status: "draft", rules: isObject(payload.rules) ? payload.rules : {}, weights: normalizeIndicatorWeights(payload.weights), model_version: typeof payload.modelVersion === "string" && payload.modelVersion ? payload.modelVersion : DEFAULT_MODEL_VERSION, model_config: isObject(payload.modelConfig) ? payload.modelConfig : {}, parent_version: typeof payload.parentVersion === "string" ? payload.parentVersion : null, created_by: actorId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const { data, error } = await this.client.from("strategy_versions").insert(row).select("version,name,status,parent_version").single();
    if (error || !data) throw new Error("策略草稿创建失败");
    return { item: data };
  }

  async publish(version: string, payload: Record<string, unknown>) {
    return serializePublication(async () => this.publishWithCompensation(version, payload));
  }

  private async publishWithCompensation(version: string, payload: Record<string, unknown>) {
    const effectiveFrom = typeof payload.effectiveFrom === "string" ? payload.effectiveFrom : new Date().toISOString();
    if (Number.isNaN(Date.parse(effectiveFrom))) throw new Error("生效时间无效");
    const targetResult = await this.client.from("strategy_versions").select("version,status,effective_from,published_at,retired_at,model_config").eq("version", version).maybeSingle();
    if (targetResult.error) throw new Error("策略读取失败");
    const target = targetResult.data ? structuredClone(targetResult.data as StrategySnapshot) : null;
    if (!target) throw new Error("策略不存在");
    if (target.status !== "draft") throw new Error("只能发布 draft 策略");
    const publishedResult = await this.client.from("strategy_versions").select("version,status,effective_from,published_at,retired_at,model_config").eq("status", "published");
    if (publishedResult.error) throw new Error("当前策略快照读取失败");
    const priorStrategies = structuredClone((publishedResult.data || []) as StrategySnapshot[]);
    const patternsResult = await this.client.from("learned_patterns").select("id,pattern_key,strategy_version,status,published_at,retired_at").in("status", ["published","draft"]).or(`strategy_version.eq.${version},status.eq.published`);
    if (patternsResult.error) throw new Error("学习模式快照读取失败");
    const patternSnapshots = structuredClone((patternsResult.data || []) as PatternSnapshot[]);
    const now = new Date().toISOString();
    try {
      await checked(this.client.from("strategy_versions").update({ status:"retired", retired_at:effectiveFrom, updated_at:now }).eq("status","published"), "旧策略退役失败");
      const published = await this.client.from("strategy_versions").update({ status:"published", effective_from:effectiveFrom, published_at:now, retired_at:null, updated_at:now, model_config: clearGovernanceFailure(target.model_config) }).eq("version",version).eq("status","draft").select("version,name,status,effective_from,parent_version").maybeSingle();
      if (published.error || !published.data) throw new Error("策略发布冲突");
      await checked(this.client.from("learned_patterns").update({ status:"retired", retired_at:effectiveFrom }).eq("status","published"), "旧学习模式退役失败");
      await checked(this.client.from("learned_patterns").update({ status:"published", published_at:now, retired_at:null }).eq("strategy_version",version), "学习模式发布失败");
      const verification = await this.client.from("strategy_versions").select("version,status").eq("status","published");
      const active = (verification.data || []) as StrategySnapshot[];
      if (verification.error || active.length !== 1 || active[0].version !== version) throw new Error("策略发布一致性校验失败");
      return { item: published.data };
    } catch (cause) {
      const original = cause instanceof Error ? cause.message : "策略发布失败";
      const compensationErrors = await this.compensatePublication(target, priorStrategies, patternSnapshots, original);
      throw new Error(compensationErrors.length ? `${original}；补偿不完整：${compensationErrors.join("、")}` : `${original}；已恢复发布前状态`);
    }
  }

  private async compensatePublication(target: StrategySnapshot, strategies: StrategySnapshot[], patterns: PatternSnapshot[], failure: string) {
    const errors:string[]=[]; const now=new Date().toISOString();
    await safeUpdate(this.client.from("strategy_versions").update({ status:"draft", effective_from:target.effective_from||null, published_at:target.published_at||null, retired_at:target.retired_at||null, updated_at:now, model_config:{...(target.model_config||{}),governanceFailure:{message:failure,recordedAt:now}} }).eq("version",target.version), "目标策略恢复失败", errors);
    for(const snapshot of strategies) await safeUpdate(this.client.from("strategy_versions").update({ status:snapshot.status,effective_from:snapshot.effective_from||null,published_at:snapshot.published_at||null,retired_at:snapshot.retired_at||null,updated_at:now }).eq("version",snapshot.version), `策略 ${snapshot.version} 恢复失败`, errors);
    for(const snapshot of patterns){const query=this.client.from("learned_patterns").update({status:snapshot.status,published_at:snapshot.published_at||null,retired_at:snapshot.retired_at||null});const restore=snapshot.id!==undefined?query.eq("id",snapshot.id):query.eq("pattern_key",snapshot.pattern_key||"");await safeUpdate(restore, `模式 ${snapshot.pattern_key||snapshot.id} 恢复失败`, errors);}
    const expectedStrategies=new Map([target,...strategies].map(snapshot=>[snapshot.version,snapshot.status]));
    try{const verification=await this.client.from("strategy_versions").select("version,status").in("version",[...expectedStrategies.keys()]);if(verification.error)errors.push("策略补偿校验读取失败");else{const actual=new Map(((verification.data||[]) as StrategySnapshot[]).map(row=>[row.version,row.status]));for(const [version,status] of expectedStrategies)if(actual.get(version)!==status)errors.push(`策略 ${version} 补偿校验失败`);}}catch{errors.push("策略补偿校验读取失败");}
    const patternIds=patterns.map(snapshot=>snapshot.id).filter((id):id is number=>id!==undefined);
    if(patternIds.length){try{const verification=await this.client.from("learned_patterns").select("id,status").in("id",patternIds);if(verification.error)errors.push("模式补偿校验读取失败");else{const actual=new Map(((verification.data||[]) as PatternSnapshot[]).map(row=>[row.id,row.status]));for(const snapshot of patterns)if(snapshot.id!==undefined&&actual.get(snapshot.id)!==snapshot.status)errors.push(`模式 ${snapshot.pattern_key||snapshot.id} 补偿校验失败`);}}catch{errors.push("模式补偿校验读取失败");}}
    return errors;
  }

  async rollback(targetVersion: string, actorId: string) {
    const { data: target, error } = await this.client.from("strategy_versions").select("name,rules,weights,model_version,model_config").eq("version", targetVersion).maybeSingle();
    if (error) throw new Error("回退目标读取失败");
    if (!target) throw new Error("回退目标不存在");
    const draft = await this.createDraft({ name:`Rollback to ${targetVersion}`, rules:target.rules, weights:target.weights, modelVersion:target.model_version, modelConfig:clearGovernanceFailure(target.model_config), parentVersion:targetVersion }, actorId);
    try { const published=await this.publish(String(draft.item.version),{effectiveFrom:new Date().toISOString()});return {...published,rolledBackTo:targetVersion}; }
    catch(error){throw new Error(`策略回退失败：${error instanceof Error?error.message:"未知错误"}`);}
  }
}

async function serializePublication<T>(operation:()=>Promise<T>):Promise<T>{const previous=publicationQueue;let release!:()=>void;publicationQueue=new Promise<void>(resolve=>{release=resolve;});await previous;try{return await operation();}finally{release();}}
async function checked(query:PromiseLike<{error?:unknown}>,message:string){const result=await query;if(result.error)throw new Error(message);}
async function safeUpdate(query:PromiseLike<{error?:unknown}>,message:string,errors:string[]){try{const result=await query;if(result.error)errors.push(message);}catch{errors.push(message);}}
function clearGovernanceFailure(value:unknown){if(!isObject(value))return {};const rest={...value};delete rest.governanceFailure;return rest;}
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
