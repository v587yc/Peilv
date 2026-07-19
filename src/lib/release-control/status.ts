import type { GitHubWorkflowRun } from "@/lib/github/github-actions-adapter";
import type { OperationStatus } from "@/lib/release-control/types";

export function mapOperationStatus(run: GitHubWorkflowRun): OperationStatus {
  if (run.status === "queued" || run.status === "requested" || run.status === "pending") return "queued";
  if (run.status === "waiting") return "waiting_approval";
  if (run.status !== "completed") return "running";
  if (run.conclusion === "success") {
    if (run.name === "Production preflight" || run.display_title.startsWith("Preflight ")) return "passed";
    return "succeeded";
  }
  if (run.conclusion === "cancelled" || run.conclusion === "skipped") return "cancelled";
  if ((run.name === "Production preflight" || run.display_title.startsWith("Preflight ")) && run.conclusion === "failure") return "blocked";
  return "failed";
}
