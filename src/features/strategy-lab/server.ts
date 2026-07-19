import "server-only";
import type { StrategyLabApplicationService } from "./application-service";
import { PostgresStrategyLabRepository, type StrategyLabSqlClient } from "./postgres-repository";
import { getOrCreateStrategyLabPgOwner } from "./postgres-sql-client";
import { PostgresLeaguePolicy } from "./postgres-league-policy";
import { PostgresStrategyLabVersionProvider } from "./postgres-version-provider";
import { PostgresSnapshotCaptureValidator, PostgresSnapshotInputProvider } from "./postgres-snapshot-input-provider";
import { ReleaseManifestBuildIdentityProvider } from "./trusted-build-identity";
import { BUILT_IN_STRATEGY_ARTIFACTS } from "./strategy-artifacts";
import { BuiltInStrategyArtifactRuntimeRegistry } from "./strategy-runtime";
import { PostgresSettlementCalculator } from "./postgres-settlement-calculator";
import {
  buildStrategyLabProductionService,
  inspectStrategyLabProductionDependencies,
  type StrategyLabProductionDependencyState,
} from "./production-server";

let testOverride: StrategyLabApplicationService | null | undefined;
let productionState: StrategyLabServerState | undefined;

export interface StrategyLabServerState {
  readonly service: StrategyLabApplicationService | null;
  readonly sqlClient: StrategyLabSqlClient | null;
  readonly configured: boolean;
  readonly dependencies: StrategyLabProductionDependencyState;
}

export function createStrategyLabProductionState(input: {
  readonly databaseUrl?: string;
  readonly ca?: string;
  readonly sqlClient?: StrategyLabSqlClient;
  readonly buildId?: string;
  readonly releaseManifestPath?: string;
} = {}): StrategyLabServerState {
  const dependencies = inspectStrategyLabProductionDependencies({});
  const databaseUrl = input.databaseUrl?.trim();
  if (!databaseUrl) return Object.freeze({ service: null, sqlClient: null, configured: false, dependencies });
  try {
    const sqlClient = input.sqlClient ?? getOrCreateStrategyLabPgOwner({ databaseUrl, ca: input.ca }).client;
    const repository = new PostgresStrategyLabRepository(sqlClient);
    const leaguePolicy = new PostgresLeaguePolicy(sqlClient);
    const buildId = input.buildId ?? "";
    const versionProvider = new PostgresStrategyLabVersionProvider(sqlClient, leaguePolicy, buildId, new ReleaseManifestBuildIdentityProvider(input.releaseManifestPath ?? "release-manifest.json"));
    const partial = {
      repository,
      snapshotProvider: new PostgresSnapshotInputProvider(sqlClient),
      captureValidator: new PostgresSnapshotCaptureValidator(sqlClient),
      leaguePolicy,
      versionProvider,
      runtimeRegistry: new BuiltInStrategyArtifactRuntimeRegistry(BUILT_IN_STRATEGY_ARTIFACTS),
      currentBuildId: buildId,
      settlementCalculator: new PostgresSettlementCalculator(sqlClient),
    };
    return Object.freeze({
      service: buildStrategyLabProductionService(partial),
      sqlClient,
      configured: true,
      dependencies: inspectStrategyLabProductionDependencies(partial),
    });
  } catch {
    return Object.freeze({ service: null, sqlClient: null, configured: true, dependencies });
  }
}

export function getStrategyLabServerState(): StrategyLabServerState {
  if (!productionState) productionState = createStrategyLabProductionState({
    databaseUrl: process.env.STRATEGY_LAB_DATABASE_URL,
    ca: process.env.STRATEGY_LAB_DATABASE_CA,
    buildId: process.env.STRATEGY_LAB_BUILD_ID,
    releaseManifestPath: process.env.STRATEGY_LAB_RELEASE_MANIFEST,
  });
  return productionState;
}

/** Production remains fail-closed until every application provider is installed. */
export function getStrategyLabService(): StrategyLabApplicationService | null {
  return process.env.NODE_ENV === "test" && testOverride !== undefined ? testOverride : getStrategyLabServerState().service;
}

/** Test-only registration. Always call the returned restore function in afterEach/finally. */
export function registerStrategyLabServiceForTests(service: StrategyLabApplicationService | null): () => void {
  if (process.env.NODE_ENV !== "test") throw new Error("test-only strategy lab registration");
  const previous = testOverride;
  testOverride = service;
  return () => { testOverride = previous; };
}
