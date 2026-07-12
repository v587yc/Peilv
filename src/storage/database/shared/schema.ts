import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const dateKeyCheck = (column: AnyPgColumn) =>
  sql`${column} ~ '^[0-9]{8}$' AND to_char(to_date(${column}, 'YYYYMMDD'), 'YYYYMMDD') = ${column}`;

export const healthCheck = pgTable("health_check", {
  id: serial("id").primaryKey(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const schemaMigrations = pgTable("schema_migrations", {
  version: varchar("version", { length: 100 }).primaryKey(),
  description: text("description").notNull(),
  checksum: text("checksum"),
  appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
});

export const predictionData = pgTable(
  "prediction_data",
  {
    id: serial("id").primaryKey(),
    dateKey: varchar("date_key", { length: 8 }).notNull(),
    jsonContent: text("json_content").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("prediction_data_date_key_check", dateKeyCheck(table.dateKey)),
    index("prediction_data_date_key_idx").on(table.dateKey),
    uniqueIndex("prediction_data_date_key_unique").on(table.dateKey),
  ],
);

export const matchOdds = pgTable(
  "match_odds",
  {
    id: serial("id").primaryKey(),
    matchId: varchar("match_id", { length: 20 }).notNull(),
    matchDate: varchar("match_date", { length: 8 }).notNull(),
    companyIds: text("company_ids").default("3,35,42,47").notNull(),
    oddsData: text("odds_data").notNull(),
    openTimesData: text("open_times_data").default("{}"),
    crownLiveOdds: text("crown_live_odds"),
    crown12Odds: text("crown_12_odds"),
    source: text("source"),
    sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }),
    writeToken: text("write_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("match_odds_match_date_check", dateKeyCheck(table.matchDate)),
    index("match_odds_match_date_idx").on(table.matchDate),
    index("match_odds_match_id_idx").on(table.matchId),
    uniqueIndex("match_odds_match_date_id_unique").on(table.matchId, table.matchDate),
  ],
);

export const matchResults = pgTable(
  "match_results",
  {
    id: serial("id").primaryKey(),
    matchId: varchar("match_id", { length: 20 }).notNull(),
    matchDate: varchar("match_date", { length: 8 }).notNull(),
    status: text("status").default("pending").notNull(),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    homeHalfScore: integer("home_half_score"),
    awayHalfScore: integer("away_half_score"),
    scoreSource: text("score_source"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("match_results_match_date_check", dateKeyCheck(table.matchDate)),
    index("match_results_match_date_idx").on(table.matchDate),
    index("match_results_status_idx").on(table.status, table.updatedAt),
    uniqueIndex("match_results_match_date_unique").on(table.matchId, table.matchDate),
  ],
);

export const dailyReports = pgTable(
  "daily_reports",
  {
    id: serial("id").primaryKey(),
    reportDate: varchar("report_date", { length: 8 }).notNull(),
    reportContent: text("report_content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("daily_reports_report_date_check", dateKeyCheck(table.reportDate)),
    index("daily_reports_report_date_idx").on(table.reportDate),
    uniqueIndex("daily_reports_report_date_unique").on(table.reportDate),
  ],
);

const predictionResultColumns = {
  id: serial("id").primaryKey(),
  matchId: varchar("match_id", { length: 20 }).notNull(),
  matchDate: varchar("match_date", { length: 8 }).notNull(),
  source: text("source").default("production").notNull(),
  runId: text("run_id"),
  homeTeam: text("home_team"),
  awayTeam: text("away_team"),
  league: text("league"),
  matchTime: text("match_time"),
  waterDirection: text("water_direction"),
  handicapTrend: text("handicap_trend"),
  prediction: text("prediction"),
  totalTrend: text("total_trend"),
  totalPrediction: text("total_prediction"),
  confidenceLevel: text("confidence_level"),
  accuracy: text("accuracy"),
  strategy: text("strategy"),
  action: text("action"),
  totalAction: text("total_action"),
  indicatorHandicapDirection: text("indicator_handicap_direction"),
  indicatorWaterDirection: text("indicator_water_direction"),
  indicatorDivergence: text("indicator_divergence"),
  indicatorEuroAsian: text("indicator_euro_asian"),
  indicatorOpenTime: text("indicator_open_time"),
  indicatorTotalGoals: text("indicator_total_goals"),
  upScore: real("up_score"),
  downScore: real("down_score"),
  crownHandicap: text("crown_handicap"),
  yingheHandicap: text("yinghe_handicap"),
  whoOpenLater: text("who_open_later"),
  indicatorsJson: jsonb("indicators_json"),
  newsSummary: text("news_summary"),
  llmReasoning: text("llm_reasoning"),
  priorityRulesJson: jsonb("priority_rules_json"),
  strategyVersion: text("strategy_version"),
  weightsVersion: text("weights_version"),
  modelVersion: text("model_version"),
  weightsSnapshot: jsonb("weights_snapshot"),
  predictionRevision: integer("prediction_revision"),
  handicapSettlementLine: real("handicap_settlement_line"),
  totalSettlementLine: real("total_settlement_line"),
  handicapSnapshotId: integer("handicap_snapshot_id"),
  totalSnapshotId: integer("total_snapshot_id"),
  handicapSettlementBasis: text("handicap_settlement_basis"),
  totalSettlementBasis: text("total_settlement_basis"),
  handicapSelection: text("handicap_selection"),
  totalSelection: text("total_selection"),
  actualScoreMargin: integer("actual_score_margin"),
  actualTotalGoals: integer("actual_total_goals"),
  probabilityOutput: jsonb("probability_output"),
  probabilityModelVersion: text("probability_model_version"),
  probabilityCalibrationVersion: text("probability_calibration_version"),
  probabilitySourceObservedAt: timestamp("probability_source_observed_at", { withTimezone: true }),
  probabilityQualityStatus: text("probability_quality_status").default("unavailable").notNull(),
  handicapAutoOutcome: text("handicap_auto_outcome"),
  handicapAutoIsCorrect: boolean("handicap_auto_is_correct"),
  handicapManualIsCorrect: boolean("handicap_manual_is_correct"),
  handicapEffectiveIsCorrect: boolean("handicap_effective_is_correct"),
  handicapAutomaticStatus: text("handicap_automatic_status").default("pending").notNull(),
  handicapEffectiveStatus: text("handicap_effective_status").default("unverified").notNull(),
  handicapSettlementReason: text("handicap_settlement_reason"),
  handicapAutoVerifiedAt: timestamp("handicap_auto_verified_at", { withTimezone: true }),
  handicapManualVerifiedAt: timestamp("handicap_manual_verified_at", { withTimezone: true }),
  handicapFinalVerifiedAt: timestamp("handicap_final_verified_at", { withTimezone: true }),
  handicapVerifiedBy: text("handicap_verified_by"),
  totalAutoOutcome: text("total_auto_outcome"),
  totalAutoIsCorrect: boolean("total_auto_is_correct"),
  totalManualIsCorrect: boolean("total_manual_is_correct"),
  totalEffectiveIsCorrect: boolean("total_effective_is_correct"),
  totalAutomaticStatus: text("total_automatic_status").default("pending").notNull(),
  totalEffectiveStatus: text("total_effective_status").default("unverified").notNull(),
  totalSettlementReason: text("total_settlement_reason"),
  totalAutoVerifiedAt: timestamp("total_auto_verified_at", { withTimezone: true }),
  totalManualVerifiedAt: timestamp("total_manual_verified_at", { withTimezone: true }),
  totalFinalVerifiedAt: timestamp("total_final_verified_at", { withTimezone: true }),
  totalVerifiedBy: text("total_verified_by"),
  isCorrect: boolean("is_correct"),
  manualIsCorrect: boolean("manual_is_correct"),
  effectiveIsCorrect: boolean("effective_is_correct"),
  verificationStatus: text("verification_status").default("pending").notNull(),
  waterVerificationStatus: text("water_verification_status").default("pending").notNull(),
  totalVerificationStatus: text("total_verification_status").default("pending").notNull(),
  effectiveVerificationStatus: text("effective_verification_status").default("unverified").notNull(),
  autoIsCorrect: boolean("auto_is_correct"),
  actualHandicapTrend: text("actual_handicap_trend"),
  actualWaterDirection: text("actual_water_direction"),
  autoVerifiedAt: timestamp("auto_verified_at", { withTimezone: true }),
  manuallyVerifiedAt: timestamp("manually_verified_at", { withTimezone: true }),
  manuallyVerifiedBy: text("manually_verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const predictionResults = pgTable(
  "prediction_results",
  predictionResultColumns,
  (table) => [
    check("prediction_results_match_date_check", dateKeyCheck(table.matchDate)),
    index("prediction_results_match_date_idx").on(table.matchDate),
    index("prediction_results_match_id_idx").on(table.matchId),
    index("prediction_results_versions_idx").on(table.strategyVersion, table.weightsVersion, table.modelVersion),
    uniqueIndex("prediction_results_match_date_unique").on(table.matchId, table.matchDate),
  ],
);

export const predictionResultsBacktest = pgTable(
  "prediction_results_backtest",
  predictionResultColumns,
  (table) => [
    check("prediction_results_backtest_match_date_check", dateKeyCheck(table.matchDate)),
    index("prediction_results_backtest_date_idx").on(table.matchDate),
    uniqueIndex("prediction_results_backtest_run_match_unique").on(table.runId, table.matchId, table.matchDate),
  ],
);

const learnedPatternColumns = {
  id: serial("id").primaryKey(),
  patternKey: text("pattern_key").notNull(),
  patternDescription: text("pattern_description"),
  league: text("league").default("ALL").notNull(),
  market: text("market").default("handicap").notNull(),
  totalPredictions: real("total_predictions").default(0).notNull(),
  correctPredictions: real("correct_predictions").default(0).notNull(),
  hitRate: real("hit_rate").default(0).notNull(),
  indicatorSignals: jsonb("indicator_signals"),
  suggestedWeights: jsonb("suggested_weights"),
  strategyVersion: text("strategy_version"),
  weightsVersion: text("weights_version"),
  modelVersion: text("model_version"),
  status: text("status").default("draft").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  trainingWindowStart: varchar("training_window_start", { length: 8 }),
  trainingWindowEnd: varchar("training_window_end", { length: 8 }),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow().notNull(),
};

export const learnedPatterns = pgTable(
  "learned_patterns",
  learnedPatternColumns,
  (table) => [
    check("learned_patterns_training_start_check", dateKeyCheck(table.trainingWindowStart)),
    check("learned_patterns_training_end_check", dateKeyCheck(table.trainingWindowEnd)),
    index("learned_patterns_league_idx").on(table.league),
    index("learned_patterns_status_idx").on(table.status, table.publishedAt),
    uniqueIndex("learned_patterns_market_key_unique").on(table.market, table.patternKey, table.league),
  ],
);

export const learnedPatternsBacktest = pgTable(
  "learned_patterns_backtest",
  learnedPatternColumns,
  (table) => [
    check("learned_patterns_backtest_training_start_check", dateKeyCheck(table.trainingWindowStart)),
    check("learned_patterns_backtest_training_end_check", dateKeyCheck(table.trainingWindowEnd)),
    uniqueIndex("learned_patterns_backtest_market_key_unique").on(table.market, table.patternKey, table.league),
  ],
);

export const strategyVersions = pgTable(
  "strategy_versions",
  {
    version: text("version").primaryKey(),
    name: text("name").notNull(),
    status: text("status").default("draft").notNull(),
    rules: jsonb("rules").default({}).notNull(),
    weights: jsonb("weights").default({}).notNull(),
    modelVersion: text("model_version").notNull(),
    modelConfig: jsonb("model_config").default({}).notNull(),
    parentVersion: text("parent_version"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("strategy_versions_status_idx").on(table.status, table.effectiveFrom)],
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const memoryBank = pgTable(
  "memory_bank",
  {
    id: serial("id").primaryKey(),
    conversationId: text("conversation_id"),
    memoryType: text("memory_type").default("short"),
    content: text("content"),
    score: real("score").default(0),
    keywords: text("keywords"),
    originalId: text("original_id"),
    summary: text("summary"),
    compressedAt: timestamp("compressed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("memory_bank_conversation_idx").on(table.conversationId)],
);

export const leagueSelections = pgTable(
  "league_selections",
  {
    id: serial("id").primaryKey(),
    dateKey: varchar("date_key", { length: 8 }).notNull(),
    mode: varchar("mode", { length: 20 }).default("today").notNull(),
    leagueName: text("league_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("league_selections_date_key_check", dateKeyCheck(table.dateKey)),
    index("league_selections_date_mode_idx").on(table.dateKey, table.mode),
    uniqueIndex("league_selections_date_mode_league_unique").on(table.dateKey, table.mode, table.leagueName),
  ],
);

export const userFocusedLeagues = pgTable(
  "user_focused_leagues",
  {
    id: serial("id").primaryKey(),
    leagueName: text("league_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("user_focused_leagues_name_unique").on(table.leagueName)],
);

export const backtestJobs = pgTable(
  "backtest_jobs",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key"),
    status: text("status").notNull(),
    currentStep: text("current_step"),
    startDate: varchar("start_date", { length: 8 }).notNull(),
    endDate: varchar("end_date", { length: 8 }).notNull(),
    currentDate: varchar("current_date", { length: 8 }).notNull(),
    totalDates: integer("total_dates").default(0).notNull(),
    processedDates: integer("processed_dates").default(0).notNull(),
    totalMatches: integer("total_matches").default(0).notNull(),
    analyzedMatches: integer("analyzed_matches").default(0).notNull(),
    verifiedMatches: integer("verified_matches").default(0).notNull(),
    correctMatches: integer("correct_matches").default(0).notNull(),
    accuracy: text("accuracy").default("0%").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    lockOwner: text("lock_owner"),
    lockExpiresAt: timestamp("lock_expires_at", { withTimezone: true }),
    log: jsonb("log").default([]).notNull(),
    result: jsonb("result"),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("backtest_jobs_start_date_check", dateKeyCheck(table.startDate)),
    check("backtest_jobs_end_date_check", dateKeyCheck(table.endDate)),
    check("backtest_jobs_current_date_check", dateKeyCheck(table.currentDate)),
    index("backtest_jobs_status_idx").on(table.status, table.updatedAt),
    uniqueIndex("backtest_jobs_idempotency_unique").on(table.idempotencyKey),
  ],
);

export const automationTasks = pgTable(
  "automation_tasks",
  {
    id: text("id").primaryKey(),
    taskType: text("task_type").notNull(),
    dateKey: varchar("date_key", { length: 8 }).notNull(),
    matchId: varchar("match_id", { length: 20 }),
    source: text("source").default("production").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").default("pending").notNull(),
    currentStep: text("current_step"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    lockOwner: text("lock_owner"),
    lockExpiresAt: timestamp("lock_expires_at", { withTimezone: true }),
    payload: jsonb("payload").default({}).notNull(),
    result: jsonb("result"),
    lastError: text("last_error"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("automation_tasks_date_key_check", dateKeyCheck(table.dateKey)),
    index("automation_tasks_status_schedule_idx").on(table.status, table.scheduledAt),
    index("automation_tasks_date_type_idx").on(table.dateKey, table.taskType),
    index("automation_tasks_match_type_status_idx").on(table.matchId, table.taskType, table.status),
    uniqueIndex("automation_tasks_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("automation_tasks_single_running_analysis")
      .on(sql`(1)`)
      .where(sql`${table.status} = 'running' AND ${table.taskType} IN ('analysis', 'match-t30-analysis')`),
  ],
);

export const automationTaskSteps = pgTable(
  "automation_task_steps",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => automationTasks.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    ordinal: integer("ordinal").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    input: jsonb("input").default({}).notNull(),
    output: jsonb("output"),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("automation_task_steps_task_idx").on(table.taskId, table.ordinal),
    uniqueIndex("automation_task_steps_task_step_unique").on(table.taskId, table.stepKey),
    uniqueIndex("automation_task_steps_idempotency_unique").on(table.idempotencyKey),
  ],
);

export const oddsSnapshots = pgTable(
  "odds_snapshots",
  {
    id: serial("id").primaryKey(),
    matchId: varchar("match_id", { length: 20 }).notNull(),
    matchDate: varchar("match_date", { length: 8 }).notNull(),
    companyId: varchar("company_id", { length: 20 }).notNull(),
    marketType: text("market_type").notNull(),
    snapshotType: text("snapshot_type").notNull(),
    source: text("source").notNull(),
    odds: jsonb("odds").notNull(),
    sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).defaultNow().notNull(),
    contentHash: text("content_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("odds_snapshots_match_date_check", dateKeyCheck(table.matchDate)),
    index("odds_snapshots_match_time_idx").on(table.matchId, table.matchDate, table.collectedAt),
    index("odds_snapshots_market_idx").on(table.companyId, table.marketType, table.collectedAt),
    uniqueIndex("odds_snapshots_idempotency_unique").on(table.idempotencyKey),
  ],
);

export const dataQualityRecords = pgTable(
  "data_quality_records",
  {
    id: serial("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    dateKey: varchar("date_key", { length: 8 }).notNull(),
    dimension: text("dimension").notNull(),
    status: text("status").notNull(),
    completenessScore: real("completeness_score"),
    source: text("source").notNull(),
    sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    issueCodes: jsonb("issue_codes").default([]).notNull(),
    details: jsonb("details").default({}).notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("data_quality_records_date_key_check", dateKeyCheck(table.dateKey)),
    check(
      "data_quality_records_completeness_check",
      sql`${table.completenessScore} IS NULL OR (${table.completenessScore} >= 0 AND ${table.completenessScore} <= 1)`,
    ),
    index("data_quality_records_entity_idx").on(table.entityType, table.entityId, table.checkedAt),
    index("data_quality_records_status_idx").on(table.status, table.dateKey),
    uniqueIndex("data_quality_records_observation_unique").on(
      table.entityType,
      table.entityId,
      table.dateKey,
      table.dimension,
      table.source,
      table.checkedAt,
    ),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    actorId: text("actor_id"),
    actorType: text("actor_type").default("system").notNull(),
    action: text("action").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id"),
    requestId: text("request_id"),
    idempotencyKey: text("idempotency_key"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_logs_object_idx").on(table.objectType, table.objectId, table.createdAt),
    index("audit_logs_actor_idx").on(table.actorId, table.createdAt),
    index("audit_logs_action_idx").on(table.action, table.createdAt),
  ],
);

export const migrationDuplicateArchive = pgTable(
  "migration_duplicate_archive",
  {
    id: serial("id").primaryKey(),
    migrationVersion: text("migration_version").notNull(),
    tableName: text("table_name").notNull(),
    naturalKey: jsonb("natural_key").notNull(),
    retainedId: text("retained_id").notNull(),
    archivedId: text("archived_id").notNull(),
    archivedRow: jsonb("archived_row").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("migration_duplicate_archive_lookup_idx").on(table.tableName, table.archivedAt),
    uniqueIndex("migration_duplicate_archive_row_unique").on(table.migrationVersion, table.tableName, table.archivedId),
  ],
);
