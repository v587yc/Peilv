import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
    hashVersion: text("hash_version").default("legacy-json-v1").notNull(),
    canonicalContentHash: text("canonical_content_hash"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("odds_snapshots_match_date_check", dateKeyCheck(table.matchDate)),
    check("odds_snapshots_hash_contract_check", sql`(${table.hashVersion} = 'legacy-json-v1' AND ${table.canonicalContentHash} IS NULL) OR (${table.hashVersion} = 'canonical-json-v2' AND ${table.canonicalContentHash} IS NOT NULL AND ${table.canonicalContentHash} ~ '^[0-9a-f]{64}$' AND ${table.contentHash} = ${table.canonicalContentHash})`),
    index("odds_snapshots_match_time_idx").on(table.matchId, table.matchDate, table.collectedAt),
    index("odds_snapshots_market_idx").on(table.companyId, table.marketType, table.collectedAt),
    index("odds_snapshots_strategy_lab_evidence_idx").on(table.matchId, table.matchDate, table.companyId, table.marketType, table.snapshotType, table.sourceObservedAt, table.collectedAt, table.hashVersion),
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
    uniqueIndex("audit_logs_command_success_unique").on(table.action, table.idempotencyKey).where(sql`${table.idempotencyKey} IS NOT NULL AND ${table.action} LIKE '%.succeeded'`),
  ],
);

export const adminUsers = pgTable("admin_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex("admin_users_username_unique").on(table.username), index("admin_users_role_active_idx").on(table.role, table.isActive)]);

export const adminSessions = pgTable("admin_sessions", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  adminUserId: text("admin_user_id").references(() => adminUsers.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  username: text("username").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex("admin_sessions_token_unique").on(table.tokenHash), index("admin_sessions_user_idx").on(table.adminUserId, table.expiresAt)]);

export const adminLoginRateLimits = pgTable("admin_login_rate_limits", {
  keyHash: text("key_hash").primaryKey(),
  keyKind: text("key_kind").notNull(),
  failureCount: integer("failure_count").default(0).notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).defaultNow().notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [index("admin_login_rate_limits_cleanup_idx").on(table.updatedAt)]);

export const adminLoginAttemptBuckets = pgTable("admin_login_attempt_buckets", {
  keyHash: text("key_hash").primaryKey(), keyKind: text("key_kind").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(), failureCount: integer("failure_count").default(0).notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [index("admin_login_attempt_buckets_cleanup_idx").on(table.updatedAt)]);

export const adminLoginAttemptReservations = pgTable("admin_login_attempt_reservations", {
  tokenHash: text("token_hash").primaryKey(), globalKey: text("global_key").notNull(), sourceKey: text("source_key"),
  subjectKey: text("subject_key").notNull(), sourceSubjectKey: text("source_subject_key"), subjectKnown: boolean("subject_known").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [index("admin_login_attempt_reservations_expiry_idx").on(table.expiresAt), index("admin_login_attempt_reservations_global_idx").on(table.globalKey, table.expiresAt)]);

export const managementCommandReceipts = pgTable(
  "management_command_receipts",
  {
    id: serial("id").primaryKey(), action: text("action").notNull(), idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(), status: text("status").default("accepted").notNull(),
    resultReference: jsonb("result_reference"), safeError: text("safe_error"), actorId: text("actor_id"), requestId: text("request_id"),
    auditContext: jsonb("audit_context"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("management_command_receipts_action_key_unique").on(table.action, table.idempotencyKey), index("management_command_receipts_status_idx").on(table.status, table.updatedAt)],
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

export const strategyLabSnapshotSets = pgTable(
  "strategy_lab_snapshot_sets",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id").notNull().references(() => strategyLabExperimentRuns.id),
    matchId: varchar("match_id", { length: 20 }).notNull(),
    matchDate: varchar("match_date", { length: 8 }).notNull(),
    checkpointType: text("checkpoint_type").notNull(),
    checkpointAt: timestamp("checkpoint_at", { withTimezone: true }).notNull(),
    datasetMode: text("dataset_mode").notNull(),
    status: text("status").notNull(),
    previousSnapshotSetId: uuid("previous_snapshot_set_id")
      .references((): AnyPgColumn => strategyLabSnapshotSets.id),
    revision: integer("revision").notNull(),
    supersedesSnapshotSetId: uuid("supersedes_snapshot_set_id")
      .references((): AnyPgColumn => strategyLabSnapshotSets.id),
    sourceCutoffAt: timestamp("source_cutoff_at", { withTimezone: true }).notNull(),
    contentHash: text("content_hash").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    completeness: jsonb("completeness").notNull(),
    traceId: text("trace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  table => [
    check("strategy_lab_snapshot_sets_match_date_check", dateKeyCheck(table.matchDate)),
    check("strategy_lab_snapshot_sets_checkpoint_check", sql`${table.checkpointType} IN ('T1215', 'T30', 'T03')`),
    check("strategy_lab_snapshot_sets_dataset_mode_check", sql`${table.datasetMode} IN ('strict_asof', 'reconstructed')`),
    check("strategy_lab_snapshot_sets_status_check", sql`${table.status} IN ('ready', 'partial', 'insufficient', 'invalid', 'missing')`),
    check("strategy_lab_snapshot_sets_completeness_check", sql`${table.status} IN ('ready', 'partial') OR (jsonb_typeof(${table.completeness}) = 'object' AND btrim(COALESCE(${table.completeness}->>'reasonCode', '')) <> '')`),
    check("strategy_lab_snapshot_sets_schema_version_check", sql`${table.schemaVersion} > 0`),
    check("strategy_lab_snapshot_sets_revision_check", sql`${table.revision} > 0`),
    check("strategy_lab_snapshot_sets_hash_check", sql`btrim(${table.contentHash}) <> ''`),
    check("strategy_lab_snapshot_sets_trace_check", sql`btrim(${table.traceId}) <> ''`),
    check("strategy_lab_snapshot_sets_cutoff_check", sql`${table.datasetMode} = 'reconstructed' OR ${table.sourceCutoffAt} <= ${table.checkpointAt}`),
    check("strategy_lab_snapshot_sets_not_self_previous_check", sql`${table.previousSnapshotSetId} IS NULL OR ${table.previousSnapshotSetId} <> ${table.id}`),
    check("strategy_lab_snapshot_sets_not_self_supersedes_check", sql`${table.supersedesSnapshotSetId} IS NULL OR ${table.supersedesSnapshotSetId} <> ${table.id}`),
    uniqueIndex("strategy_lab_snapshot_sets_revision_unique").on(
      table.runId, table.matchId, table.matchDate, table.checkpointType, table.checkpointAt,
      table.datasetMode, table.schemaVersion, table.revision,
    ),
    uniqueIndex("strategy_lab_snapshot_sets_content_unique").on(
      table.runId, table.matchId, table.matchDate, table.checkpointType, table.checkpointAt,
      table.datasetMode, table.schemaVersion, table.contentHash,
    ),
    uniqueIndex("strategy_lab_snapshot_sets_supersedes_unique")
      .on(table.supersedesSnapshotSetId)
      .where(sql`${table.supersedesSnapshotSetId} IS NOT NULL`),
    index("strategy_lab_snapshot_sets_match_checkpoint_idx").on(
      table.runId, table.matchId, table.matchDate, table.checkpointType, table.checkpointAt,
    ),
  ],
);

export const strategyLabSnapshotItems = pgTable(
  "strategy_lab_snapshot_items",
  {
    snapshotSetId: uuid("snapshot_set_id").notNull().references(() => strategyLabSnapshotSets.id),
    oddsSnapshotId: integer("odds_snapshot_id").notNull().references(() => oddsSnapshots.id),
    role: text("role").notNull(),
    companyId: varchar("company_id", { length: 20 }).notNull(),
    marketType: text("market_type").notNull(),
    snapshotType: text("snapshot_type").notNull(),
    sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  table => [
    check("strategy_lab_snapshot_items_role_check", sql`${table.role} = 'current'`),
    check("strategy_lab_snapshot_items_company_check", sql`btrim(${table.companyId}) <> ''`),
    check("strategy_lab_snapshot_items_market_check", sql`btrim(${table.marketType}) <> ''`),
    check("strategy_lab_snapshot_items_snapshot_type_check", sql`btrim(${table.snapshotType}) <> ''`),
    primaryKey({ name: "strategy_lab_snapshot_items_pkey", columns: [table.snapshotSetId, table.oddsSnapshotId, table.role] }),
    uniqueIndex("strategy_lab_snapshot_items_one_current_unique").on(table.snapshotSetId),
    index("strategy_lab_snapshot_items_set_market_idx").on(table.snapshotSetId, table.marketType, table.role),
  ],
);

export const strategyLabExperimentRuns = pgTable(
  "strategy_lab_experiment_runs",
  {
    id: uuid("id").primaryKey(),
    runType: text("run_type").notNull(),
    status: text("status").notNull(),
    datasetMode: text("dataset_mode").notNull(),
    startDate: varchar("start_date", { length: 8 }).notNull(),
    endDate: varchar("end_date", { length: 8 }).notNull(),
    datasetCutoffAt: timestamp("dataset_cutoff_at", { withTimezone: true }).notNull(),
    strategyVersions: jsonb("strategy_versions").notNull(),
    configuration: jsonb("configuration").notNull(),
    codeVersion: text("code_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdBy: text("created_by").notNull(),
    traceId: text("trace_id").notNull(),
    errorSummary: text("error_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  table => [
    check("strategy_lab_experiment_runs_type_check", sql`${table.runType} IN ('shadow', 'backtest', 'manual')`),
    check("strategy_lab_experiment_runs_status_check", sql`${table.status} IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')`),
    check("strategy_lab_experiment_runs_dataset_mode_check", sql`${table.datasetMode} IN ('strict_asof', 'reconstructed')`),
    check("strategy_lab_experiment_runs_start_date_check", dateKeyCheck(table.startDate)),
    check("strategy_lab_experiment_runs_end_date_check", dateKeyCheck(table.endDate)),
    check("strategy_lab_experiment_runs_range_check", sql`${table.startDate} <= ${table.endDate}`),
    check("strategy_lab_experiment_runs_identity_check", sql`btrim(${table.codeVersion}) <> '' AND btrim(${table.idempotencyKey}) <> '' AND btrim(${table.createdBy}) <> '' AND btrim(${table.traceId}) <> ''`),
    check("strategy_lab_experiment_runs_time_check", sql`
      ${table.updatedAt} >= ${table.createdAt}
      AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt})
      AND (${table.finishedAt} IS NULL OR ${table.finishedAt} >= ${table.createdAt})
      AND (
        (${table.status} = 'pending' AND ${table.startedAt} IS NULL AND ${table.finishedAt} IS NULL)
        OR (${table.status} = 'running' AND ${table.startedAt} IS NOT NULL AND ${table.finishedAt} IS NULL AND ${table.updatedAt} >= ${table.startedAt})
        OR (${table.status} IN ('succeeded', 'failed') AND ${table.startedAt} IS NOT NULL AND ${table.finishedAt} IS NOT NULL AND ${table.finishedAt} >= ${table.startedAt} AND ${table.updatedAt} >= ${table.finishedAt})
        OR (${table.status} = 'cancelled' AND ${table.finishedAt} IS NOT NULL AND (${table.startedAt} IS NULL OR ${table.finishedAt} >= ${table.startedAt}) AND ${table.updatedAt} >= ${table.finishedAt})
      )
    `),
    uniqueIndex("strategy_lab_experiment_runs_idempotency_unique").on(table.idempotencyKey),
    index("strategy_lab_experiment_runs_status_idx").on(table.status, table.createdAt),
    index("strategy_lab_experiment_runs_date_idx").on(table.startDate, table.endDate, table.datasetMode),
  ],
);

export const strategyLabPredictions = pgTable(
  "strategy_lab_predictions",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id").notNull().references(() => strategyLabExperimentRuns.id),
    matchId: varchar("match_id", { length: 20 }).notNull(),
    matchDate: varchar("match_date", { length: 8 }).notNull(),
    checkpointType: text("checkpoint_type").notNull(),
    snapshotSetId: uuid("snapshot_set_id").notNull().references(() => strategyLabSnapshotSets.id),
    requestedStrategy: text("requested_strategy").notNull(),
    executedStrategy: text("executed_strategy").notNull(),
    strategyVersion: text("strategy_version").notNull().references(() => strategyVersions.version),
    decisionStatus: text("decision_status").notNull(),
    selection: text("selection"),
    lockedDeterministic: boolean("locked_deterministic").notNull(),
    reasonCode: text("reason_code").notNull(),
    branchId: text("branch_id").notNull(),
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash").notNull(),
    decisionPayload: jsonb("decision_payload").notNull(),
    fallbackReason: text("fallback_reason"),
    legacyPredictionId: integer("legacy_prediction_id").references(() => predictionResults.id),
    source: text("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    traceId: text("trace_id").notNull(),
    evidenceContractVersion: integer("evidence_contract_version").default(1).notNull(),
    executionCutoffAt: timestamp("execution_cutoff_at", { withTimezone: true }),
    executedActualQuoteSnapshotId: integer("executed_actual_quote_snapshot_id").references(() => oddsSnapshots.id),
    theoreticalHandicapRaw: text("theoretical_handicap_raw"),
    theoreticalHandicapQuarterUnits: integer("theoretical_handicap_quarter_units"),
    theoreticalSelectedWater: numeric("theoretical_selected_water", { precision: 7, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  table => [
    check("strategy_lab_predictions_match_date_check", dateKeyCheck(table.matchDate)),
    check("strategy_lab_predictions_checkpoint_check", sql`${table.checkpointType} IN ('T1215', 'T30', 'T03')`),
    check("strategy_lab_predictions_requested_check", sql`${table.requestedStrategy} IN ('A', 'B', 'C', 'D')`),
    check("strategy_lab_predictions_executed_check", sql`${table.executedStrategy} IN ('A', 'B', 'C', 'D')`),
    check("strategy_lab_predictions_identity_check", sql`(${table.requestedStrategy} = 'C' AND ${table.executedStrategy} IN ('C', 'A')) OR (${table.requestedStrategy} <> 'C' AND ${table.executedStrategy} = ${table.requestedStrategy})`),
    check("strategy_lab_predictions_fallback_check", sql`(${table.requestedStrategy} = 'C' AND ${table.executedStrategy} = 'A' AND ${table.fallbackReason} IS NOT NULL AND btrim(${table.fallbackReason}) <> '') OR (NOT (${table.requestedStrategy} = 'C' AND ${table.executedStrategy} = 'A') AND ${table.fallbackReason} IS NULL)`),
    check("strategy_lab_predictions_status_check", sql`${table.decisionStatus} IN ('recommend', 'observe', 'reanalyze_required', 'insufficient_data')`),
    check("strategy_lab_predictions_selection_check", sql`(${table.decisionStatus} = 'recommend' AND ${table.selection} IS NOT NULL AND ${table.selection} IN ('home', 'away')) OR (${table.decisionStatus} <> 'recommend' AND ${table.selection} IS NULL)`),
    check("strategy_lab_predictions_source_check", sql`${table.source} IN ('experiment', 'd_compat_shadow')`),
    check("strategy_lab_predictions_evidence_contract_check", sql`${table.evidenceContractVersion} IN (1,2)`),
    check("strategy_lab_predictions_execution_evidence_check", sql`
      (${table.evidenceContractVersion}=1 AND ${table.executionCutoffAt} IS NULL AND ${table.executedActualQuoteSnapshotId} IS NULL
        AND ${table.theoreticalHandicapRaw} IS NULL AND ${table.theoreticalHandicapQuarterUnits} IS NULL AND ${table.theoreticalSelectedWater} IS NULL)
      OR (${table.evidenceContractVersion}=2 AND (
        (${table.decisionStatus}<>'recommend' AND ${table.executionCutoffAt} IS NULL AND ${table.executedActualQuoteSnapshotId} IS NULL
          AND ${table.theoreticalHandicapRaw} IS NULL AND ${table.theoreticalHandicapQuarterUnits} IS NULL AND ${table.theoreticalSelectedWater} IS NULL)
        OR (${table.decisionStatus}='recommend' AND ${table.executionCutoffAt} IS NOT NULL AND
          ((${table.executedActualQuoteSnapshotId} IS NOT NULL AND ${table.theoreticalHandicapRaw} IS NULL AND ${table.theoreticalHandicapQuarterUnits} IS NULL AND ${table.theoreticalSelectedWater} IS NULL)
          OR (${table.executedActualQuoteSnapshotId} IS NULL AND ${table.theoreticalHandicapRaw} IS NOT NULL AND ${table.theoreticalHandicapQuarterUnits} BETWEEN -80 AND 80 AND ${table.theoreticalSelectedWater}>0 AND ${table.theoreticalSelectedWater}<=5))))))
    `),
    check("strategy_lab_predictions_required_text_check", sql`btrim(${table.strategyVersion}) <> '' AND btrim(${table.reasonCode}) <> '' AND btrim(${table.branchId}) <> '' AND btrim(${table.inputHash}) <> '' AND btrim(${table.outputHash}) <> '' AND btrim(${table.idempotencyKey}) <> '' AND btrim(${table.traceId}) <> ''`),
    uniqueIndex("strategy_lab_predictions_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("strategy_lab_predictions_matrix_unique").on(table.runId, table.matchId, table.matchDate, table.checkpointType, table.requestedStrategy),
    index("strategy_lab_predictions_run_matrix_idx").on(table.runId, table.checkpointType, table.requestedStrategy, table.decisionStatus),
    index("strategy_lab_predictions_match_idx").on(table.matchId, table.matchDate, table.checkpointType),
  ],
);

export const strategyLabMatchResultRevisions = pgTable(
  "strategy_lab_match_result_revisions",
  {
    id: uuid("id").primaryKey(),
    sourceMatchResultId: integer("source_match_result_id").notNull().references(() => matchResults.id),
    matchId: varchar("match_id", { length: 20 }).notNull(),
    matchDate: varchar("match_date", { length: 8 }).notNull(),
    status: text("status").notNull(),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    scoreSource: text("score_source").notNull(),
    sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }).notNull(),
    sourceSettledAt: timestamp("source_settled_at", { withTimezone: true }),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    contentHash: text("content_hash").notNull(),
    revision: integer("revision").notNull(),
    supersedes: uuid("supersedes").references((): AnyPgColumn => strategyLabMatchResultRevisions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  table => [
    check("strategy_lab_match_result_revisions_status_check", sql`${table.status} IN ('finished', 'pending', 'special')`),
    check("strategy_lab_match_result_revisions_revision_check", sql`${table.revision} > 0`),
    check("strategy_lab_match_result_revisions_result_check", sql`(${table.status}='finished' AND ${table.homeScore} BETWEEN 0 AND 99 AND ${table.awayScore} BETWEEN 0 AND 99 AND ${table.sourceSettledAt} IS NOT NULL) OR (${table.status}<>'finished' AND ${table.homeScore} IS NULL AND ${table.awayScore} IS NULL AND ${table.sourceSettledAt} IS NULL)`),
    check("strategy_lab_match_result_revisions_time_check", sql`${table.sourceObservedAt}<=${table.sourceUpdatedAt} AND (${table.sourceSettledAt} IS NULL OR ${table.sourceObservedAt}<=${table.sourceSettledAt})`),
    check("strategy_lab_match_result_revisions_hash_check", sql`${table.contentHash}~'^[0-9a-f]{64}$'`),
    uniqueIndex("strategy_lab_match_result_revisions_identity_unique").on(table.matchId, table.matchDate, table.revision),
    uniqueIndex("strategy_lab_match_result_revisions_source_hash_unique").on(table.sourceMatchResultId, table.contentHash),
    uniqueIndex("strategy_lab_match_result_revisions_supersedes_unique").on(table.supersedes),
    index("strategy_lab_match_result_revisions_latest_idx").on(table.matchId, table.matchDate, table.revision),
  ],
);

export const strategyLabSettlements = pgTable(
  "strategy_lab_settlements",
  {
    id: uuid("id").primaryKey(),
    predictionId: uuid("prediction_id").notNull().references(() => strategyLabPredictions.id),
    revision: integer("revision").notNull(),
    matchResultId: integer("match_result_id").notNull().references(() => matchResults.id),
    matchResultRevisionId: uuid("match_result_revision_id").references(() => strategyLabMatchResultRevisions.id),
    actualQuoteSnapshotId: integer("actual_quote_snapshot_id").references(() => oddsSnapshots.id),
    quoteBasis: text("quote_basis").notNull(),
    outcome: text("outcome").notNull(),
    profitUnits: numeric("profit_units", { precision: 12, scale: 6 }),
    isCounted: boolean("is_counted").notNull(),
    settlementBasis: text("settlement_basis").notNull(),
    evidence: jsonb("evidence").notNull(),
    calculatorVersion: text("calculator_version"),
    evidenceHash: text("evidence_hash"),
    quoteHandicapRaw: text("quote_handicap_raw"),
    quoteHandicapQuarterUnits: integer("quote_handicap_quarter_units"),
    quoteSelectedWater: numeric("quote_selected_water", { precision: 7, scale: 6 }),
    quoteSelectedWaterMillionths: integer("quote_selected_water_millionths"),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
    settledBy: text("settled_by").notNull(),
    supersedes: uuid("supersedes").references((): AnyPgColumn => strategyLabSettlements.id),
    traceId: text("trace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  table => [
    check("strategy_lab_settlements_revision_check", sql`${table.revision} > 0`),
    check("strategy_lab_settlements_quote_basis_check", sql`${table.quoteBasis} IN ('actual', 'theoretical')`),
    check("strategy_lab_settlements_outcome_check", sql`${table.outcome} IN ('win', 'half_win', 'push', 'half_loss', 'loss', 'unavailable')`),
    check("strategy_lab_settlements_basis_pair_check", sql`
      (${table.quoteBasis} = 'actual' AND ${table.settlementBasis} = 'actual_quote'
        AND ${table.actualQuoteSnapshotId} IS NOT NULL
        AND jsonb_typeof(${table.evidence}) = 'object'
        AND NOT (${table.evidence} ? 'actualQuoteSnapshotId')
        AND NOT (${table.evidence} ? 'theoreticalQuote'))
      OR (${table.quoteBasis} = 'theoretical' AND ${table.settlementBasis} = 'theoretical_quote'
        AND ${table.actualQuoteSnapshotId} IS NULL
        AND jsonb_typeof(${table.evidence}) = 'object'
        AND ${table.evidence} ? 'theoreticalQuote'
        AND jsonb_typeof(${table.evidence}->'theoreticalQuote') = 'object'
        AND ${table.evidence}->'theoreticalQuote' <> '{}'::jsonb
        AND NOT (${table.evidence} ? 'actualQuoteSnapshotId'))
    `),
    check("strategy_lab_settlements_profit_check", sql`
      (${table.outcome} = 'unavailable' AND ${table.profitUnits} IS NULL AND ${table.isCounted} = FALSE)
      OR (${table.outcome} IN ('win', 'half_win') AND ${table.profitUnits} IS NOT NULL AND ${table.profitUnits} > 0 AND ${table.isCounted} = TRUE)
      OR (${table.outcome} = 'push' AND ${table.profitUnits} IS NOT NULL AND ${table.profitUnits} = 0 AND ${table.isCounted} = TRUE)
      OR (${table.outcome} IN ('half_loss', 'loss') AND ${table.profitUnits} IS NOT NULL AND ${table.profitUnits} < 0 AND ${table.isCounted} = TRUE)
    `),
    check("strategy_lab_settlements_identity_check", sql`btrim(${table.settledBy}) <> '' AND btrim(${table.traceId}) <> ''`),
    check("strategy_lab_settlements_not_self_supersedes_check", sql`${table.supersedes} IS NULL OR ${table.supersedes} <> ${table.id}`),
    uniqueIndex("strategy_lab_settlements_revision_unique").on(table.predictionId, table.revision),
    uniqueIndex("strategy_lab_settlements_supersedes_unique")
      .on(table.supersedes)
      .where(sql`${table.supersedes} IS NOT NULL`),
    index("strategy_lab_settlements_prediction_idx").on(table.predictionId, table.revision),
    index("strategy_lab_settlements_result_idx").on(table.matchResultId, table.quoteBasis, table.isCounted),
    index("strategy_lab_settlements_actual_quote_idx")
      .on(table.actualQuoteSnapshotId)
      .where(sql`${table.actualQuoteSnapshotId} IS NOT NULL`),
  ],
);

export const strategyLabCommandReceipts = pgTable(
  "strategy_lab_command_receipts",
  {
    id: uuid("id").primaryKey(), action: text("action").notNull(), operationKey: text("operation_key").notNull(),
    payloadHash: text("payload_hash").notNull(), status: text("status").notNull().default("audit_pending"),
    resultType: text("result_type").notNull(), resultId: uuid("result_id").notNull(), actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(), auditAttempts: integer("audit_attempts").notNull().default(0),
    lastAuditErrorCode: text("last_audit_error_code"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(), auditedAt: timestamp("audited_at", { withTimezone: true }),
  },
  table => [
    check("strategy_lab_command_receipts_action_check", sql`${table.action} IN ('run.create','run.transition','snapshot.capture','prediction.execute','settlement.create')`),
    check("strategy_lab_command_receipts_status_check", sql`${table.status} IN ('audit_pending','audited')`),
    check("strategy_lab_command_receipts_result_type_check", sql`${table.resultType} IN ('strategy_lab_run','strategy_lab_snapshot','strategy_lab_prediction','strategy_lab_settlement')`),
    check("strategy_lab_command_receipts_required_text_check", sql`btrim(${table.operationKey})<>'' AND btrim(${table.payloadHash})<>'' AND btrim(${table.resultType})<>'' AND btrim(${table.actorId})<>'' AND btrim(${table.requestId})<>''`),
    check("strategy_lab_command_receipts_audit_check", sql`${table.auditAttempts}>=0 AND ((${table.status}='audit_pending' AND ${table.auditedAt} IS NULL) OR (${table.status}='audited' AND ${table.auditedAt} IS NOT NULL))`),
    uniqueIndex("strategy_lab_command_receipts_action_key_unique").on(table.action, table.operationKey),
    index("strategy_lab_command_receipts_pending_idx").on(table.status, table.createdAt).where(sql`${table.status}='audit_pending'`),
  ],
);

export const strategyLabMatchFacts = pgTable("strategy_lab_match_facts", {
  id: uuid("id").primaryKey(), matchId: varchar("match_id", { length: 20 }).notNull(), matchDate: varchar("match_date", { length: 8 }).notNull(),
  leagueNameRaw: text("league_name_raw").notNull(), leagueNameNormalized: text("league_name_normalized").notNull(), kickoffAt: timestamp("kickoff_at", { withTimezone: true }).notNull(),
  source: text("source").notNull(), sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }).notNull(), datasetCutoffAt: timestamp("dataset_cutoff_at", { withTimezone: true }).notNull(),
  canonicalPayload: jsonb("canonical_payload").notNull(), contentHash: text("content_hash").notNull(), revision: integer("revision").notNull(), supersedesId: uuid("supersedes_id").references((): AnyPgColumn => strategyLabMatchFacts.id),
  schemaVersion: integer("schema_version").notNull(), traceId: text("trace_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  check("strategy_lab_match_facts_date_check", dateKeyCheck(table.matchDate)),
  uniqueIndex("strategy_lab_match_facts_revision_unique").on(table.matchId,table.matchDate,table.source,table.schemaVersion,table.revision),
  uniqueIndex("strategy_lab_match_facts_content_unique").on(table.matchId,table.matchDate,table.source,table.schemaVersion,table.contentHash),
  uniqueIndex("strategy_lab_match_facts_supersedes_unique").on(table.supersedesId).where(sql`${table.supersedesId} IS NOT NULL`),
  index("strategy_lab_match_facts_asof_idx").on(table.matchId,table.matchDate,table.datasetCutoffAt,table.revision),
]);

export const strategyLabFocusedLeagueBaselines = pgTable("strategy_lab_focused_league_baselines", {
  id:uuid("id").primaryKey(), source:text("source").notNull(), sourceObservedAt:timestamp("source_observed_at",{withTimezone:true}).notNull(), datasetCutoffAt:timestamp("dataset_cutoff_at",{withTimezone:true}).notNull(), canonicalPayload:jsonb("canonical_payload").notNull(), contentHash:text("content_hash").notNull().unique(), memberCount:integer("member_count").notNull(), isComplete:boolean("is_complete").notNull(), completedAt:timestamp("completed_at",{withTimezone:true}), actor:text("actor").notNull(), traceId:text("trace_id").notNull(), createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull(),
});
export const strategyLabFocusedLeagueEvents = pgTable("strategy_lab_focused_league_events", {
  id: uuid("id").primaryKey(), baselineId: uuid("baseline_id").notNull().references(()=>strategyLabFocusedLeagueBaselines.id), source:text("source").notNull(), leagueNameRaw:text("league_name_raw").notNull(), leagueNameNormalized:text("league_name_normalized").notNull(), action:text("action").notNull(), sourceObservedAt:timestamp("source_observed_at",{withTimezone:true}).notNull(), datasetCutoffAt:timestamp("dataset_cutoff_at",{withTimezone:true}).notNull(), canonicalPayload:jsonb("canonical_payload").notNull(), contentHash:text("content_hash").notNull(), revision:integer("revision").notNull(), supersedesId:uuid("supersedes_id").references(():AnyPgColumn=>strategyLabFocusedLeagueEvents.id), actor:text("actor").notNull(), traceId:text("trace_id").notNull(), createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull(),
});
export const strategyLabLeaguePolicyArtifacts = pgTable("strategy_lab_league_policy_artifacts", { contentHash:text("content_hash").primaryKey(),versionHash:text("version_hash").notNull().unique(),mode:text("mode").notNull(),leagues:jsonb("leagues").notNull(),canonicalPayload:jsonb("canonical_payload").notNull(),sourceRowCount:integer("source_row_count").notNull(),schemaVersion:integer("schema_version").notNull(),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull() });
export const strategyLabLeaguePolicyCaptures = pgTable("strategy_lab_league_policy_captures", { id:uuid("id").primaryKey(),artifactHash:text("artifact_hash").notNull().references(()=>strategyLabLeaguePolicyArtifacts.contentHash),datasetCutoffAt:timestamp("dataset_cutoff_at",{withTimezone:true}).notNull(),capturedAt:timestamp("captured_at",{withTimezone:true}).notNull(),sourceHistoryCutoff:timestamp("source_history_cutoff",{withTimezone:true}).notNull(),evidenceHash:text("evidence_hash").notNull(),createdBy:text("created_by").notNull(),traceId:text("trace_id").notNull(),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull() });

export const strategyLabStrategyArtifacts = pgTable("strategy_lab_strategy_artifacts", {
  strategyId: text("strategy_id").notNull(), version: text("version").notNull(), artifactHash: text("artifact_hash").primaryKey(),
  engineVersion: text("engine_version").notNull(), definition: jsonb("definition").notNull(), canonicalPayload:jsonb("canonical_payload").notNull(), codeCompatibility: text("code_compatibility").notNull(), schemaVersion: integer("schema_version").notNull(), behaviorCorpusHash:text("behavior_corpus_hash").notNull(),executable:boolean("executable").notNull(),
  createdBy: text("created_by").notNull(), traceId: text("trace_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex("strategy_lab_strategy_artifacts_version_unique").on(table.strategyId,table.version)]);
export const strategyLabStrategyPublications=pgTable("strategy_lab_strategy_publications",{id:uuid("id").primaryKey(),rootId:uuid("root_id").notNull(),artifactHash:text("artifact_hash").notNull().references(()=>strategyLabStrategyArtifacts.artifactHash),status:text("status").notNull(),effectiveFrom:timestamp("effective_from",{withTimezone:true}).notNull(),effectiveTo:timestamp("effective_to",{withTimezone:true}),revision:integer("revision").notNull(),supersedesId:uuid("supersedes_id").references(():AnyPgColumn=>strategyLabStrategyPublications.id),publishedAt:timestamp("published_at",{withTimezone:true}).notNull(),retiredAt:timestamp("retired_at",{withTimezone:true}),actor:text("actor").notNull(),traceId:text("trace_id").notNull(),createdAt:timestamp("created_at",{withTimezone:true}).defaultNow().notNull()});

export const strategyLabBuildArtifacts = pgTable("strategy_lab_build_artifacts", {
  buildId: text("build_id").primaryKey(), manifestDigest: text("manifest_digest").notNull(), commitSha: text("commit_sha").notNull(), releaseId: text("release_id").notNull(), artifactDigest:text("artifact_digest").notNull(), compatibility: text("compatibility").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
