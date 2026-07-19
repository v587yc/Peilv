export interface CandidateIdentity {
  releaseId: string;
  commitSha: string;
  sourceRunId: number;
  sourceRunAttempt: number;
  sourceArtifactId: number;
  archiveSha256?: string;
}
export interface PreflightResult {
  schemaVersion: 1;
  status: "passed" | "blocked";
  phase: string;
  code: string;
  exitCode: number;
  requestId: string | null;
  candidate: CandidateIdentity | null;
  currentRelease: string | null;
  checks: unknown[];
  migrations: Record<string, unknown> | null;
  blockers: string[];
  checkedAt: string;
  validUntil: string | null;
  [key: string]: unknown;
}
export function loadJson(file: string): { migrations?: Array<{ file: string; version: string }>; [key: string]: unknown };
export function candidateFromEnvironment(env?: Record<string, string | undefined>): CandidateIdentity | null;
export function createBlockedResult(input: { phase: string; code: string; exitCode: number; env?: Record<string, string | undefined> }): PreflightResult;
export function normalizeRemoteResult(remote: Record<string, unknown>, env?: Record<string, string | undefined>): PreflightResult;
export function validateResult(result: unknown): boolean;
export function renderMarkdown(result: PreflightResult): string;
