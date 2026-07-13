import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit-log";
import { authorizeDeploymentRequest } from "@/lib/deployment-auth";
import {
  dispatchDeploy,
  getRun,
  listOperations,
  listRunArtifacts,
} from "@/lib/github/github-actions-adapter";

const releaseIdSchema = z.string().regex(/^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/);
const inputSchema = z.object({
  preflightRunId: z.number().int().positive(),
  releaseId: releaseIdSchema,
  confirmation: releaseIdSchema,
}).strict();

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function parseRequestId(request: Request) {
  const supplied = request.headers.get("x-request-id");
  return supplied && z.string().uuid().safeParse(supplied).success ? supplied : randomUUID();
}

export async function POST(request: NextRequest) {
  const actor = authorizeDeploymentRequest(request);
  if (!actor) return response({ success: false, error: "需要部署控制台登录" }, 401);
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.confirmation !== parsed.data.releaseId) {
    return response({ success: false, error: "必须输入完整 release ID 确认部署" }, 400);
  }

  const input = parsed.data;
  const requestId = parseRequestId(request);
  try {
    const [preflightRun, artifacts, operations] = await Promise.all([
      getRun(input.preflightRunId),
      listRunArtifacts(input.preflightRunId),
      listOperations(),
    ]);
    if (preflightRun.status !== "completed" || preflightRun.conclusion !== "success") {
      return response({ success: false, error: "指定预检尚未成功完成" }, 409);
    }
    if ([...operations.deploy, ...operations.rollback].some(value => value.status !== "completed")) {
      return response({ success: false, error: "已有部署或回退正在执行" }, 409);
    }

    const resultArtifact = artifacts.find(value => value.name.startsWith("preflight-result-") && !value.expired);
    if (!resultArtifact) return response({ success: false, error: "预检结构化结果不存在或已过期" }, 409);

    const match = preflightRun.display_title.match(/^Preflight (r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}) · ([0-9a-f-]{36})$/);
    if (!match || match[1] !== input.releaseId || resultArtifact.name !== `preflight-result-${match[2]}`) {
      return response({ success: false, error: "预检运行、结果制品与 release 不匹配" }, 409);
    }

    const candidateMatch = /^r([1-9][0-9]*)-a([1-9][0-9]*)-([0-9a-f]{12})$/.exec(input.releaseId);
    if (!candidateMatch) return response({ success: false, error: "release ID 无效" }, 400);
    const sourceRunId = Number(candidateMatch[1]);
    const sourceRunAttempt = Number(candidateMatch[2]);
    const [sourceRun, sourceArtifacts] = await Promise.all([
      getRun(sourceRunId),
      listRunArtifacts(sourceRunId),
    ]);
    const sourceArtifact = sourceArtifacts.find(value =>
      value.name === `peilv-candidate-${sourceRunId}-${sourceRunAttempt}` && !value.expired,
    );
    if (
      sourceRun.event !== "push" || sourceRun.head_branch !== "main" ||
      sourceRun.status !== "completed" || sourceRun.conclusion !== "success" ||
      sourceRun.run_attempt !== sourceRunAttempt || sourceRun.head_sha.slice(0, 12) !== candidateMatch[3] ||
      !sourceArtifact
    ) {
      return response({ success: false, error: "源候选已变化或过期" }, 409);
    }

    await dispatchDeploy({
      sourceRunId,
      sourceRunAttempt,
      sourceArtifactId: sourceArtifact.id,
      preflightRunId: preflightRun.id,
      preflightArtifactId: resultArtifact.id,
      commitSha: sourceRun.head_sha,
      releaseId: input.releaseId,
      requestId,
    });
    await writeAuditLog({
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: "deployment_dispatch",
      objectType: "release_candidate",
      objectId: input.releaseId,
      requestId,
      idempotencyKey: `deployment:${requestId}`,
      newValue: {
        sourceRunId,
        sourceRunAttempt,
        sourceArtifactId: sourceArtifact.id,
        preflightRunId: preflightRun.id,
        preflightArtifactId: resultArtifact.id,
        commitSha: sourceRun.head_sha,
      },
      metadata: { username: actor.username },
    });
    return response({ success: true, requestId }, 202);
  } catch {
    return response({ success: false, error: "无法验证预检与候选绑定" }, 503);
  }
}
