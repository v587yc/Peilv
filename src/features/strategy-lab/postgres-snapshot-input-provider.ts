import "server-only";
import { canonicalJsonSha256 } from "@/lib/canonical-json";
import type { SnapshotCaptureValidator, SnapshotInputProvider, SnapshotStrategyEvidence } from "./application-service";
import { StrategyLabSnapshotDependencyError, StrategyLabSnapshotIntegrityError } from "./application-service";
import type { CaptureSnapshotApplicationInput } from "./application-schemas";
import type { StrategyLabSqlClient, StrategyLabSqlExecutor } from "./postgres-repository";
import type { StrategyLabRunRecord } from "./repository";
import { deepFreeze, normalizeHandicap, parseWaterToBasisPoints } from "./normalization";
import { computeStrategySnapshotSetHash, expectedSnapshotType, STRATEGY_LAB_SNAPSHOT_SCHEMA_VERSION } from "./snapshot-contract";

type Row = Record<string, unknown>;
type SetRow = Row & { id:string;run_id:string;match_id:string;match_date:string;checkpoint_type:"T1215"|"T30"|"T03";checkpoint_at:Date|string;dataset_mode:string;status:string;previous_snapshot_set_id:string|null;revision:number;supersedes_snapshot_set_id:string|null;source_cutoff_at:Date|string;content_hash:string;schema_version:number;completeness:Record<string,unknown>;trace_id:string };
type ItemRow = Row & { odds_snapshot_id:number;role:string;company_id:string;market_type:string;snapshot_type:string;source_observed_at:Date|string|null;collected_at:Date|string;odds:Record<string,unknown>;content_hash:string;hash_version:string;canonical_content_hash:string|null;odds_match_id:string;odds_match_date:string };
const iso=(value:unknown)=>new Date(String(value)).toISOString();
const invalid=():never=>{throw new StrategyLabSnapshotIntegrityError();};
const text=(value:unknown)=>typeof value==="string"&&value.trim()?value:null;

async function loadKickoff(tx:StrategyLabSqlExecutor,set:SetRow,runCutoff:string){
  const result=await tx.query<Row>(`SELECT DISTINCT ON(source) source,league_name_normalized,kickoff_at FROM strategy_lab_match_facts WHERE match_id=$1 AND match_date=$2 AND source_observed_at<=dataset_cutoff_at AND source_observed_at<=$3 AND dataset_cutoff_at<=$3 ORDER BY source,dataset_cutoff_at DESC,revision DESC`,[set.match_id,set.match_date,runCutoff]);
  if(!result.rows.length) throw new StrategyLabSnapshotDependencyError();
  const league=new Set(result.rows.map(row=>String(row.league_name_normalized))); const kickoff=new Set(result.rows.map(row=>iso(row.kickoff_at)));
  if(league.size!==1||kickoff.size!==1) invalid();
  return [...kickoff][0];
}

function assertCheckpoint(set:SetRow,kickoff:string){
  const actual=Date.parse(iso(set.checkpoint_at)); const kickoffMs=Date.parse(kickoff);
  let expected:number;
  if(set.checkpoint_type==="T1215"){
    const date=set.match_date; expected=Date.UTC(Number(date.slice(0,4)),Number(date.slice(4,6))-1,Number(date.slice(6,8)),4,15,0,0);
  }else expected=kickoffMs-(set.checkpoint_type==="T30"?30:3)*60_000;
  if(actual!==expected||actual>=kickoffMs) invalid();
}

function setHash(set:SetRow,items:readonly ItemRow[]){
  const snapshot={runId:set.run_id,matchId:set.match_id,matchDate:set.match_date,checkpointType:set.checkpoint_type,checkpointAt:iso(set.checkpoint_at),status:set.status,previousSnapshotSetId:set.previous_snapshot_set_id,revision:Number(set.revision),supersedesSnapshotSetId:set.supersedes_snapshot_set_id,sourceCutoffAt:iso(set.source_cutoff_at),schemaVersion:Number(set.schema_version),completeness:set.completeness,datasetMode:set.dataset_mode};
  const hashItems=items.map(item=>({oddsSnapshotId:Number(item.odds_snapshot_id),role:item.role,companyId:item.company_id,marketType:item.market_type,snapshotType:item.snapshot_type,sourceObservedAt:item.source_observed_at?iso(item.source_observed_at):null,collectedAt:iso(item.collected_at)}));
  return computeStrategySnapshotSetHash(snapshot,hashItems);
}

function validateItems(set:SetRow,items:readonly ItemRow[],runCutoff:string,kickoff:string){
  if(set.schema_version!==STRATEGY_LAB_SNAPSHOT_SCHEMA_VERSION||set.dataset_mode!=="strict_asof") invalid();
  const checkpoint=Date.parse(iso(set.checkpoint_at));
  const cutoff=Date.parse(iso(set.source_cutoff_at));
  const runCutoffMs=Date.parse(runCutoff);
  if(cutoff>checkpoint||cutoff>runCutoffMs||checkpoint>runCutoffMs||checkpoint>=Date.parse(kickoff)) invalid();
  for(const item of items){
    if(item.odds_match_id!==set.match_id||item.odds_match_date!==set.match_date||!item.source_observed_at) invalid();
    const observed=Date.parse(iso(item.source_observed_at)),collected=Date.parse(iso(item.collected_at));
    if(observed>collected||observed>cutoff||collected>cutoff||observed>checkpoint||collected>checkpoint||observed>runCutoffMs||collected>runCutoffMs||observed>=Date.parse(kickoff)||collected>=Date.parse(kickoff)) invalid();
    if(item.hash_version!=="canonical-json-v2"||!item.canonical_content_hash||canonicalJsonSha256(item.odds)!==item.canonical_content_hash||item.content_hash!==item.canonical_content_hash) invalid();
    if(item.role!=="current") invalid();
  }
  if(setHash(set,items)!==set.content_hash) invalid();
}

function currentPayload(set:SetRow,items:readonly ItemRow[],rejectInvalid=true){
  if(rejectInvalid&&set.status==="invalid")invalid();
  const shouldHaveCurrent=set.status==="ready"||set.status==="partial";
  if(items.length!==(shouldHaveCurrent?1:0))invalid();
  if(!shouldHaveCurrent)return null;
  const item=items[0];
  if(item.role!=="current"||item.company_id!=="3"||item.market_type!=="asian_handicap"||item.snapshot_type!==expectedSnapshotType(set.checkpoint_type))invalid();
  const home=text(item.odds.handicapHome),line=text(item.odds.handicapLine),away=text(item.odds.handicapAway);
  if((home&&!parseWaterToBasisPoints(home))||(away&&!parseWaterToBasisPoints(away))||(line&&!normalizeHandicap(line)))invalid();
  if(set.status==="ready"&&(!home||!line||!away))invalid();
  return {homeWater:home,handicap:line,awayWater:away};
}

async function loadItems(tx:StrategyLabSqlExecutor,id:string){
  return (await tx.query<ItemRow>(`SELECT i.*,o.match_id odds_match_id,o.match_date odds_match_date,o.odds,o.content_hash,o.hash_version,o.canonical_content_hash FROM strategy_lab_snapshot_items i JOIN odds_snapshots o ON o.id=i.odds_snapshot_id WHERE i.snapshot_set_id=$1 ORDER BY i.odds_snapshot_id,i.role`,[id])).rows;
}
async function loadSet(tx:StrategyLabSqlExecutor,id:string){return (await tx.query<SetRow>(`SELECT * FROM strategy_lab_snapshot_sets WHERE id=$1`,[id])).rows[0]??null;}

export class PostgresSnapshotInputProvider implements SnapshotInputProvider {
  constructor(private readonly client:StrategyLabSqlClient){}
  async load(snapshotSetId:string):Promise<Readonly<SnapshotStrategyEvidence>|null>{
    try{return await this.client.transaction(async tx=>{
      const root=await loadSet(tx,snapshotSetId); if(!root)return null;
      const run=(await tx.query<Row>(`SELECT id,dataset_cutoff_at FROM strategy_lab_experiment_runs WHERE id=$1`,[root.run_id])).rows[0]; if(!run)invalid();
      const runCutoff=iso(run.dataset_cutoff_at); const kickoff=await loadKickoff(tx,root,runCutoff); assertCheckpoint(root,kickoff);
       const visited=new Set<string>(); let cursor:SetRow|null=root; let previous:{handicap:string}|null=null; let rootPayload:{homeWater:string|null;handicap:string|null;awayWater:string|null}|null=null;
       while(cursor){
        if(visited.has(cursor.id)||cursor.run_id!==root.run_id||cursor.match_id!==root.match_id||cursor.match_date!==root.match_date||cursor.dataset_mode!==root.dataset_mode)invalid(); visited.add(cursor.id);
        assertCheckpoint(cursor,kickoff); const items=await loadItems(tx,cursor.id); validateItems(cursor,items,runCutoff,kickoff);
        if(cursor.status==="invalid")invalid();
         const payload=currentPayload(cursor,items);
         if(cursor.id===root.id)rootPayload=payload;
         else if(!previous&&payload?.handicap)previous={handicap:payload.handicap};
         if(cursor.checkpoint_type==="T1215"){if(cursor.previous_snapshot_set_id)invalid();break;}
         const previousId=cursor.previous_snapshot_set_id;
         if(!previousId)invalid();
         const next=await loadSet(tx,previousId!);if(!next)invalid();
         const expectedPrevious=cursor.checkpoint_type==="T03"?"T30":"T1215";
         if(next.checkpoint_type!==expectedPrevious||Date.parse(iso(next.checkpoint_at))>=Date.parse(iso(cursor.checkpoint_at)))invalid();cursor=next;
       }
       const current=rootPayload??{homeWater:null,handicap:null,awayWater:null};
       const rootItems=await loadItems(tx,root.id);
       return deepFreeze({input:{checkpoint:root.checkpoint_type,current,previousEffective:root.checkpoint_type==="T1215"?null:previous},cData:{},evidenceContentHash:setHash(root,rootItems),currentOddsSnapshotId:rootItems[0]?Number(rootItems[0].odds_snapshot_id):null});
    },{readOnly:true,isolationLevel:"repeatable read"});}catch(error){if(error instanceof StrategyLabSnapshotIntegrityError||error instanceof StrategyLabSnapshotDependencyError)throw error;throw new StrategyLabSnapshotDependencyError();}
  }
}

export class PostgresSnapshotCaptureValidator implements SnapshotCaptureValidator {
  constructor(private readonly client:StrategyLabSqlClient){}
  async validate(input:Readonly<CaptureSnapshotApplicationInput>,run:Readonly<StrategyLabRunRecord>):Promise<void>{
    try{await this.client.transaction(async tx=>{
      const fake:SetRow={...input,id:"capture",run_id:input.runId,match_id:input.matchId,match_date:input.matchDate,checkpoint_type:input.checkpointType,checkpoint_at:input.checkpointAt,dataset_mode:run.datasetMode,status:input.status,previous_snapshot_set_id:input.previousSnapshotSetId,revision:input.revision,supersedes_snapshot_set_id:input.supersedesSnapshotSetId,source_cutoff_at:input.sourceCutoffAt,content_hash:"",schema_version:input.schemaVersion,completeness:input.completeness,trace_id:"capture"};
      const kickoff=await loadKickoff(tx,fake,run.datasetCutoffAt);assertCheckpoint(fake,kickoff);
       const ids=input.items.map(item=>item.oddsSnapshotId);const rows=ids.length?(await tx.query<ItemRow>(`SELECT o.id odds_snapshot_id,'current'::text role,o.company_id,o.market_type,o.snapshot_type,o.source_observed_at,o.collected_at,o.match_id odds_match_id,o.match_date odds_match_date,o.odds,o.content_hash,o.hash_version,o.canonical_content_hash FROM odds_snapshots o WHERE o.id=ANY($1::int[]) ORDER BY o.id`,[ids])).rows:[];
       if(rows.length!==input.items.length)invalid();
       for(const row of rows){const supplied=input.items.find(item=>item.oddsSnapshotId===Number(row.odds_snapshot_id));if(!supplied||supplied.role!==row.role||supplied.companyId!==row.company_id||supplied.marketType!==row.market_type||supplied.snapshotType!==row.snapshot_type||supplied.sourceObservedAt!==(row.source_observed_at?iso(row.source_observed_at):null)||supplied.collectedAt!==iso(row.collected_at))invalid();}
        validateItems({...fake,content_hash:setHash(fake,rows)},rows,run.datasetCutoffAt,kickoff);currentPayload(fake,rows,false);
    },{readOnly:true,isolationLevel:"repeatable read"});}catch(error){if(error instanceof StrategyLabSnapshotIntegrityError||error instanceof StrategyLabSnapshotDependencyError)throw error;throw new StrategyLabSnapshotDependencyError();}
  }
}
