import { afterAll, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/github/github-api-client", () => ({ githubApi: api }));

import { dispatchPreflight, listMainCandidates, listRunArtifacts } from "@/lib/github/github-actions-adapter";

const originalOwner = process.env.GITHUB_REPOSITORY_OWNER;
const originalRepo = process.env.GITHUB_REPOSITORY_NAME;

process.env.GITHUB_REPOSITORY_OWNER = "v587yc";
process.env.GITHUB_REPOSITORY_NAME = "Peilv";

describe("GitHub Actions adapter", () => {
  it("uses only the configured repository and main branch", async () => {
    api.mockResolvedValueOnce({ workflow_runs: [{
      id: 12, run_attempt: 1, name: "CI", display_title: "change", event: "push", status: "completed",
      conclusion: "success", head_sha: "a".repeat(40), head_branch: "main", html_url: "https://github.com/x/y/actions/runs/12",
      created_at: "2026-07-13T00:00:00Z", updated_at: "2026-07-13T00:01:00Z",
    }] });
    const runs = await listMainCandidates();
    expect(runs).toHaveLength(1);
    expect(api).toHaveBeenCalledWith("/repos/v587yc/Peilv/actions/workflows/ci.yml/runs?branch=main&per_page=30");
  });

  it("rejects invalid run IDs before calling GitHub", async () => {
    await expect(listRunArtifacts(-1)).rejects.toThrow("无效的 run ID");
  });

  it("dispatches preflight with only normalized fixed inputs", async () => {
    api.mockResolvedValueOnce(undefined);
    await dispatchPreflight({
      sourceRunId: 12,
      sourceRunAttempt: 1,
      sourceArtifactId: 34,
      commitSha: "a".repeat(40),
      releaseId: `r12-a1-${"a".repeat(12)}`,
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(api).toHaveBeenCalledWith(
      "/repos/v587yc/Peilv/actions/workflows/production-preflight.yml/dispatches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          ref: "main",
          inputs: {
            source_run_id: "12",
            source_run_attempt: "1",
            source_artifact_id: "34",
            commit_sha: "a".repeat(40),
            release_id: `r12-a1-${"a".repeat(12)}`,
            request_id: "123e4567-e89b-42d3-a456-426614174000",
          },
        }),
      }),
    );
  });
});

afterAll(() => {
  if (originalOwner === undefined) delete process.env.GITHUB_REPOSITORY_OWNER;
  else process.env.GITHUB_REPOSITORY_OWNER = originalOwner;
  if (originalRepo === undefined) delete process.env.GITHUB_REPOSITORY_NAME;
  else process.env.GITHUB_REPOSITORY_NAME = originalRepo;
});
