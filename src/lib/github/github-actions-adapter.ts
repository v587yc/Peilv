import { z } from "zod";
import { githubApi } from "@/lib/github/github-api-client";

const WORKFLOWS = {
  ci: "ci.yml",
  preflight: "production-preflight.yml",
  deploy: "deploy-approved-production.yml",
  rollback: "rollback-production.yml",
} as const;

const runSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive().default(1),
  name: z.string(),
  display_title: z.string(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  head_branch: z.string().nullable(),
  html_url: z.string().url(),
  created_at: z.string(),
  updated_at: z.string(),
  actor: z.object({ login: z.string() }).nullable().optional(),
  head_commit: z.object({ message: z.string(), author: z.object({ name: z.string() }).nullable().optional() }).nullable().optional(),
});

const artifactSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  size_in_bytes: z.number().int().nonnegative(),
  expired: z.boolean(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  workflow_run: z.object({ id: z.number().int().positive(), head_sha: z.string() }).nullable().optional(),
});

export type GitHubWorkflowRun = z.infer<typeof runSchema>;
export type GitHubArtifact = z.infer<typeof artifactSchema>;

function config() {
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const repo = process.env.GITHUB_REPOSITORY_NAME;
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("固定 GitHub 仓库未配置");
  }
  return { owner, repo, base: `/repos/${owner}/${repo}` };
}

async function listRuns(workflow: keyof typeof WORKFLOWS, perPage = 20): Promise<GitHubWorkflowRun[]> {
  const { base } = config();
  const result = await githubApi<unknown>(
    `${base}/actions/workflows/${WORKFLOWS[workflow]}/runs?branch=main&per_page=${Math.min(perPage, 50)}`,
  );
  return z.object({ workflow_runs: z.array(runSchema) }).parse(result).workflow_runs;
}

export async function listMainCandidates(): Promise<GitHubWorkflowRun[]> {
  return (await listRuns("ci", 30)).filter(run => run.event === "push" && run.head_branch === "main");
}

export async function listOperations() {
  const [preflight, deploy, rollback] = await Promise.all([
    listRuns("preflight", 15),
    listRuns("deploy", 15),
    listRuns("rollback", 15).catch(() => []),
  ]);
  return { preflight, deploy, rollback };
}

export async function listRunArtifacts(runId: number): Promise<GitHubArtifact[]> {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("无效的 run ID");
  const { base } = config();
  const result = await githubApi<unknown>(`${base}/actions/runs/${runId}/artifacts?per_page=50`);
  return z.object({ artifacts: z.array(artifactSchema) }).parse(result).artifacts;
}

export async function getRun(runId: number): Promise<GitHubWorkflowRun> {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("无效的 run ID");
  const { base } = config();
  return runSchema.parse(await githubApi<unknown>(`${base}/actions/runs/${runId}`));
}

const positiveIntegerInput = z.number().int().positive();
const commitShaInput = z.string().regex(/^[0-9a-f]{40}$/);
const releaseIdInput = z.string().regex(/^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/);
const requestIdInput = z.string().uuid();

const preflightDispatchSchema = z.object({
  sourceRunId: positiveIntegerInput,
  sourceRunAttempt: positiveIntegerInput,
  sourceArtifactId: positiveIntegerInput,
  commitSha: commitShaInput,
  releaseId: releaseIdInput,
  requestId: requestIdInput,
}).strict();

const deployDispatchSchema = z.object({
  sourceRunId: positiveIntegerInput,
  sourceRunAttempt: positiveIntegerInput,
  sourceArtifactId: positiveIntegerInput,
  preflightRunId: positiveIntegerInput,
  preflightArtifactId: positiveIntegerInput,
  commitSha: commitShaInput,
  releaseId: releaseIdInput,
  requestId: requestIdInput,
}).strict();

const rollbackDispatchSchema = z.object({
  targetReleaseId: releaseIdInput,
  expectedCurrentReleaseId: releaseIdInput,
  requestId: requestIdInput,
  reason: z.string().trim().min(10).max(300),
}).strict().refine(value => value.targetReleaseId !== value.expectedCurrentReleaseId, {
  message: "回退目标不能是当前版本",
});

async function dispatch(workflow: keyof typeof WORKFLOWS, inputs: Record<string, string>): Promise<void> {
  const { base } = config();
  await githubApi<void>(`${base}/actions/workflows/${WORKFLOWS[workflow]}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs }),
  });
}

export async function dispatchPreflight(input: z.input<typeof preflightDispatchSchema>): Promise<void> {
  const value = preflightDispatchSchema.parse(input);
  await dispatch("preflight", {
    source_run_id: String(value.sourceRunId),
    source_run_attempt: String(value.sourceRunAttempt),
    source_artifact_id: String(value.sourceArtifactId),
    commit_sha: value.commitSha,
    release_id: value.releaseId,
    request_id: value.requestId,
  });
}

export async function dispatchDeploy(input: z.input<typeof deployDispatchSchema>): Promise<void> {
  const value = deployDispatchSchema.parse(input);
  await dispatch("deploy", {
    source_run_id: String(value.sourceRunId),
    source_run_attempt: String(value.sourceRunAttempt),
    source_artifact_id: String(value.sourceArtifactId),
    preflight_run_id: String(value.preflightRunId),
    preflight_artifact_id: String(value.preflightArtifactId),
    commit_sha: value.commitSha,
    release_id: value.releaseId,
    request_id: value.requestId,
  });
}

export async function dispatchRollback(input: z.input<typeof rollbackDispatchSchema>): Promise<void> {
  const value = rollbackDispatchSchema.parse(input);
  await dispatch("rollback", {
    target_release_id: value.targetReleaseId,
    expected_current_release_id: value.expectedCurrentReleaseId,
    request_id: value.requestId,
    reason: value.reason,
  });
}
