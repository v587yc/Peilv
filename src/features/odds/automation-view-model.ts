import type { AutomationTaskStatusData } from "./contracts";

export function isAutomationCompensationAvailable(now = new Date()): boolean {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const hour = beijing.getUTCHours();
  const minute = beijing.getUTCMinutes();
  return hour > 12 || (hour === 12 && minute >= 2);
}

export function previousBeijingDateKey(now = new Date()): string {
  const beijingYesterday = new Date(now.getTime() + 8 * 60 * 60000 - 24 * 60 * 60000);
  return beijingYesterday.toISOString().slice(0, 10).replace(/-/g, "");
}

export function automationTaskLabel(
  type: AutomationTaskStatusData["taskType"],
): string {
  return {
    "odds-fetch": "赔率抓取",
    "crown-snapshot": "皇冠快照",
    analysis: "AI分析",
    "verify-learn-report": "验证学习报表",
  }[type];
}

export function automationStatusText(
  tasks: AutomationTaskStatusData[],
  now = new Date(),
): string {
  if (tasks.length === 0) {
    return isAutomationCompensationAvailable(now)
      ? "服务端任务未创建"
      : "服务端任务待北京时间12:02后执行";
  }

  const completed = tasks.filter((task) => task.status === "completed").length;
  const running = tasks.filter(
    (task) => task.status === "running" || task.status === "retrying",
  ).length;
  const failed = tasks.find((task) => task.status === "failed");
  if (failed) {
    const stepError = failed.steps?.find(
      (step) => step.status === "failed" && step.lastError,
    )?.lastError;
    const reason = failed.lastError || stepError || "未知错误";
    return `服务端任务 ${completed}/${tasks.length} 完成，${automationTaskLabel(failed.taskType)}失败：${reason}`;
  }
  if (running > 0) {
    return `服务端任务 ${completed}/${tasks.length} 完成，${running} 个执行中/重试中`;
  }
  return `服务端任务 ${completed}/${tasks.length} 完成`;
}
