export type CandidateStatus = "building" | "ready" | "ci_failed" | "artifact_expired";
export type OperationStatus = "queued" | "running" | "waiting_approval" | "passed" | "blocked" | "succeeded" | "failed" | "cancelled";

export type ReleaseCandidate = {
  runId: number;
  runAttempt: number;
  releaseId: string;
  commitSha: string;
  commitTitle: string;
  author: string;
  status: CandidateStatus;
  artifactId: number | null;
  artifactSize: number | null;
  artifactExpiresAt: string | null;
  createdAt: string;
  url: string;
};

export type DeploymentOperation = {
  runId: number;
  kind: "preflight" | "deploy" | "rollback";
  title: string;
  status: OperationStatus;
  actor: string | null;
  commitSha: string;
  createdAt: string;
  updatedAt: string;
  url: string;
};

export type DeploymentOverview = {
  repository: string;
  currentRelease: string | null;
  candidates: ReleaseCandidate[];
  operations: DeploymentOperation[];
  fetchedAt: string;
};
