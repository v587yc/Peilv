import type { AdminCapability } from "@/lib/auth/admin-capabilities";

export type ManagementDescriptor = {
  id: string;
  category: "settings" | "source" | "automation" | "strategy" | "backtest" | "deployment";
  label: string;
  sensitivity: "public" | "internal" | "secret";
  mutability: "read-only" | "online" | "restart-required" | "external-only";
  source: "database" | "environment" | "code" | "runtime" | "external";
  readCapability: "admin:view";
  writeCapability?: Extract<AdminCapability, "admin:configure" | "admin:execute" | "admin:dangerous">;
  audit: "none" | "metadata" | "redacted-diff";
  rollback: "not-applicable" | "restore-previous" | "compensating-command" | "external-runbook";
  secretMode?: "not-secret" | "write-only-replace" | "configured-state-only";
  confirmation?: { required: boolean; phrase: "target-id" | "fixed"; fixedValue?: string };
  idempotency: "not-applicable" | "client-key" | "domain-key";
};

const setting = (id: string, label: string, secret = false): ManagementDescriptor => ({
  id: `setting.${id}`, category: "settings", label,
  sensitivity: secret ? "secret" : "internal", mutability: "online", source: "database",
  readCapability: "admin:view", writeCapability: "admin:configure", audit: "redacted-diff",
  rollback: "restore-previous", secretMode: secret ? "write-only-replace" : "not-secret", idempotency: "client-key",
});

export const MANAGEMENT_DESCRIPTORS = [
  { ...setting("batch", "批量设置替换"), id: "setting.batch" },
  setting("llm_api_key", "LLM API Key", true), setting("llm_base_url", "LLM 服务地址"),
  setting("llm_model", "LLM 模型"), setting("search_api_key", "搜索 API Key", true),
  setting("search_base_url", "搜索服务地址"), setting("feishu_webhook_url", "飞书 Webhook", true),
  { id: "source.storage", category: "source", label: "存储", sensitivity: "internal", mutability: "external-only", source: "environment", readCapability: "admin:view", audit: "none", rollback: "external-runbook", idempotency: "not-applicable" },
  { id: "source.titan", category: "source", label: "Titan 数据源", sensitivity: "public", mutability: "read-only", source: "code", readCapability: "admin:view", audit: "none", rollback: "not-applicable", idempotency: "not-applicable" },
  { id: "automation.daily-compensation", category: "automation", label: "每日任务补偿", sensitivity: "internal", mutability: "online", source: "runtime", readCapability: "admin:view", writeCapability: "admin:execute", audit: "metadata", rollback: "compensating-command", idempotency: "domain-key" },
  { id: "strategy.draft", category: "strategy", label: "策略草稿", sensitivity: "internal", mutability: "online", source: "database", readCapability: "admin:view", writeCapability: "admin:configure", audit: "redacted-diff", rollback: "restore-previous", idempotency: "client-key" },
  { id: "strategy.publish", category: "strategy", label: "发布策略", sensitivity: "internal", mutability: "online", source: "database", readCapability: "admin:view", writeCapability: "admin:dangerous", audit: "metadata", rollback: "restore-previous", confirmation: { required: true, phrase: "target-id" }, idempotency: "client-key" },
  { id: "strategy.rollback", category: "strategy", label: "回退策略", sensitivity: "internal", mutability: "online", source: "database", readCapability: "admin:view", writeCapability: "admin:dangerous", audit: "metadata", rollback: "restore-previous", confirmation: { required: true, phrase: "target-id" }, idempotency: "client-key" },
  { id: "backtest.start", category: "backtest", label: "启动回测", sensitivity: "internal", mutability: "online", source: "database", readCapability: "admin:view", writeCapability: "admin:execute", audit: "metadata", rollback: "compensating-command", idempotency: "client-key" },
  { id: "backtest.cancel", category: "backtest", label: "取消回测", sensitivity: "internal", mutability: "online", source: "database", readCapability: "admin:view", writeCapability: "admin:execute", audit: "metadata", rollback: "not-applicable", idempotency: "client-key" },
  { id: "backtest.resume", category: "backtest", label: "继续回测", sensitivity: "internal", mutability: "online", source: "database", readCapability: "admin:view", writeCapability: "admin:execute", audit: "metadata", rollback: "compensating-command", idempotency: "client-key" },
  { id: "deployment.preflight", category: "deployment", label: "生产更新检查", sensitivity: "internal", mutability: "external-only", source: "external", readCapability: "admin:view", writeCapability: "admin:dangerous", audit: "metadata", rollback: "not-applicable", idempotency: "client-key" },
  { id: "deployment.deploy", category: "deployment", label: "生产版本更新", sensitivity: "internal", mutability: "external-only", source: "external", readCapability: "admin:view", writeCapability: "admin:dangerous", audit: "metadata", rollback: "external-runbook", confirmation: { required: true, phrase: "target-id" }, idempotency: "client-key" },
  { id: "deployment.rollback", category: "deployment", label: "生产代码恢复", sensitivity: "internal", mutability: "external-only", source: "external", readCapability: "admin:view", writeCapability: "admin:dangerous", audit: "metadata", rollback: "external-runbook", confirmation: { required: true, phrase: "target-id" }, idempotency: "client-key" },
] as const satisfies readonly ManagementDescriptor[];

const registry = new Map<string, ManagementDescriptor>(MANAGEMENT_DESCRIPTORS.map((entry) => [entry.id, entry]));
export function findManagementDescriptor(id: string): ManagementDescriptor | null { return registry.get(id) || null; }

// “版本更新/release”是 deployment 三阶段流程的产品名称，不是第四种可执行命令。
export const VERSION_UPDATE_COMMAND_MAP = Object.freeze({
  check: "deployment.preflight",
  update: "deployment.deploy",
  restorePrevious: "deployment.rollback",
} as const);
