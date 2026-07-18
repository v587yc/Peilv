import {
  listMainCandidates,
  listOperations,
  listRunArtifacts,
  type GitHubWorkflowRun,
} from "@/lib/github/github-actions-adapter";
import { mapOperationStatus } from "@/lib/release-control/status";
import type { DeploymentOperation, DeploymentOverview, ReleaseCandidate } from "@/lib/release-control/types";
import { loadProductionReleaseState } from "@/lib/release-control/production-state";
import { getSupabaseClient } from "@/storage/database/supabase-client";

function releaseId(run: GitHubWorkflowRun): string {
  return `r${run.id}-a${run.run_attempt}-${run.head_sha.slice(0, 12)}`;
}

function operation(kind: DeploymentOperation["kind"], run: GitHubWorkflowRun): DeploymentOperation {
  return {
    runId: run.id,
    kind,
    title: run.display_title || run.name,
    status: mapOperationStatus(run),
    actor: run.actor?.login ?? null,
    commitSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    url: run.html_url,
  };
}

export async function getDeploymentOverview(): Promise<DeploymentOverview> {
  const [runs, operations] = await Promise.all([listMainCandidates(), listOperations()]);
  const candidates: ReleaseCandidate[] = await Promise.all(runs.slice(0, 15).map(async run => {
    let artifact = null;
    if (run.status === "completed" && run.conclusion === "success") {
      const artifacts = await listRunArtifacts(run.id);
      artifact = artifacts.find(value => value.name === `peilv-candidate-${run.id}-${run.run_attempt}`) ?? null;
    }
    const status: ReleaseCandidate["status"] = run.status !== "completed"
      ? "building"
      : run.conclusion !== "success"
        ? "ci_failed"
        : !artifact || artifact.expired
          ? "artifact_expired"
          : "ready";
    return {
      runId: run.id,
      runAttempt: run.run_attempt,
      releaseId: releaseId(run),
      commitSha: run.head_sha,
      commitTitle: run.head_commit?.message.split("\n")[0] || run.display_title,
      author: run.head_commit?.author?.name || run.actor?.login || "unknown",
      status,
      artifactId: artifact?.id ?? null,
      artifactSize: artifact?.size_in_bytes ?? null,
      artifactExpiresAt: artifact?.expires_at ?? null,
      createdAt: run.created_at,
      url: run.html_url,
    };
  }));

  const allOperations = [
    ...operations.preflight.map(run => operation("preflight", run)),
    ...operations.deploy.map(run => operation("deploy", run)),
    ...operations.rollback.map(run => operation("rollback", run)),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const production = await loadProductionReleaseState({
    operations: [...operations.deploy, ...operations.rollback],
    client: getSupabaseClient(),
  });

  return {
    repository: `${process.env.GITHUB_REPOSITORY_OWNER}/${process.env.GITHUB_REPOSITORY_NAME}`,
    currentRelease: production.currentRelease,
    previousRelease: production.previousRelease,
    candidates,
    operations: allOperations.slice(0, 30),
    fetchedAt: new Date().toISOString(),
  };
}
