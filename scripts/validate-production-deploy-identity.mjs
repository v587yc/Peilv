#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_PREFLIGHT_PATH = ".github/workflows/production-preflight.yml";
const fail = message => { throw new Error(message); };

export function validateProductionDeployIdentity({ dispatch, source, preflight, candidate, result, repository, workflow, workflowFallback, expected }) {
  const sourceRunId = Number(expected.sourceRunId);
  const sourceAttempt = Number(expected.sourceRunAttempt);
  const preflightRunId = Number(expected.preflightRunId);
  if (dispatch?.refName !== "main" || dispatch?.sha !== expected.commitSha) fail("Deploy dispatch main identity drifted");
  if (repository?.id !== expected.repositoryId || repository?.full_name !== expected.repositoryName) fail("Repository identity mismatch");
  if (workflow?.id !== expected.preflightWorkflowId || workflow?.path !== PRODUCTION_PREFLIGHT_PATH) fail("Preflight workflow API identity mismatch");
  if (source?.repository?.id !== expected.repositoryId || source.event !== "push" || source.head_branch !== "main" || source.status !== "completed" || source.conclusion !== "success" || source.run_attempt !== sourceAttempt || source.head_sha !== expected.commitSha) fail("Source run identity mismatch");
  if (preflight?.repository?.id !== expected.repositoryId || preflight.workflow_id !== expected.preflightWorkflowId || preflight.event !== "workflow_dispatch" || preflight.head_branch !== "main" || preflight.status !== "completed" || preflight.conclusion !== "success" || preflight.run_attempt !== expected.preflightRunAttempt || preflight.head_sha !== expected.commitSha) fail("Preflight run identity mismatch");
  if (preflight.path !== undefined && preflight.path !== null && preflight.path !== "") {
    if (preflight.path !== PRODUCTION_PREFLIGHT_PATH) fail("Preflight run workflow path mismatch");
  } else if (workflowFallback?.id !== expected.preflightWorkflowId || workflowFallback?.path !== PRODUCTION_PREFLIGHT_PATH) {
    fail("Preflight workflow fallback identity mismatch");
  }
  if (candidate?.expired || candidate?.name !== `peilv-candidate-${sourceRunId}-${sourceAttempt}` || candidate?.workflow_run?.id !== sourceRunId || candidate?.workflow_run?.head_sha !== expected.commitSha) fail("Candidate artifact identity mismatch");
  if (result?.expired || result?.name !== `preflight-result-${expected.requestId}` || result?.workflow_run?.id !== preflightRunId || result?.workflow_run?.head_sha !== expected.commitSha) fail("Preflight artifact identity mismatch");
}

async function main() {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  validateProductionDeployIdentity(JSON.parse(body));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
