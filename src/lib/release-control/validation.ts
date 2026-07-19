import type { GitHubArtifact, GitHubWorkflowRun } from "@/lib/github/github-actions-adapter";

export function validateCandidateBinding(input: {
  run: GitHubWorkflowRun;
  artifact: GitHubArtifact | undefined;
  runAttempt: number;
  artifactId?: number;
  releaseId: string;
}): string | null {
  const { run, artifact } = input;
  const expectedReleaseId = `r${run.id}-a${run.run_attempt}-${run.head_sha.slice(0, 12)}`;
  if (run.event !== "push" || run.head_branch !== "main" || run.status !== "completed" || run.conclusion !== "success") return "候选运行不是成功的 main push";
  if (run.run_attempt !== input.runAttempt || input.releaseId !== expectedReleaseId) return "候选 run、attempt、SHA 或 release 不匹配";
  if (!artifact || (input.artifactId !== undefined && artifact.id !== input.artifactId) || artifact.expired) return "候选制品不存在、错配或已过期";
  if (artifact.name !== `peilv-candidate-${run.id}-${run.run_attempt}`) return "候选制品名称错配";
  if (!artifact.workflow_run || artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha) return "候选制品 provenance 错配";
  return null;
}

export function validatePreflightBinding(input: {
  run: GitHubWorkflowRun;
  artifact: GitHubArtifact | undefined;
  releaseId: string;
  now?: number;
}): string | null {
  const { run, artifact } = input;
  if (run.status !== "completed" || run.conclusion !== "success") return "指定预检尚未成功完成";
  const match = run.display_title.match(/^Preflight (r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}) · ([0-9a-f-]{36})$/);
  if (!match || match[1] !== input.releaseId) return "预检运行与 release 不匹配";
  if (!artifact || artifact.expired || artifact.name !== `preflight-result-${match[2]}` || artifact.workflow_run?.id !== run.id) return "预检结果制品不存在、错配或已过期";
  const completedAt = Date.parse(run.updated_at);
  if (!Number.isFinite(completedAt) || (input.now ?? Date.now()) - completedAt > 2 * 60 * 60 * 1000) return "预检已超过有效期";
  return null;
}
