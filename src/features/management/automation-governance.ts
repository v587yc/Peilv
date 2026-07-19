import { AUTOMATION_DEFINITIONS, beijingParts, isFixedScheduleDefinition } from "@/lib/automation/definitions";
import { AUTOMATION_TASK_TYPES, type AutomationTaskType } from "@/lib/automation/types";
import { createAutomationService } from "@/lib/automation/service";

export function automationPlans() {
  return AUTOMATION_TASK_TYPES.map(type => { const definition = AUTOMATION_DEFINITIONS[type]; return { type, schedule: isFixedScheduleDefinition(definition) ? `${String(definition.hour).padStart(2, "0")}:${String(definition.minute).padStart(2, "0")} 北京时间` : "动态触发", steps: definition.steps.map(step => ({ key: step.key, maxAttempts: step.maxAttempts || 3 })), mutable: false }; });
}
export async function loadAutomationGovernance(baseUrl: string, date?: string) {
  const service = createAutomationService(baseUrl); const dateKey = date || beijingParts(new Date()).dateKey;
  const tasks = await service.repository.list({ dateKey, limit: 50 });
  return { dateKey, plans: automationPlans(), tasks: tasks.map(task => ({ id: task.id, taskType: task.taskType, dateKey: task.dateKey, status: task.status, currentStep: task.currentStep, attemptCount: task.attemptCount, maxAttempts: task.maxAttempts, lastError: task.lastError, scheduledAt: task.scheduledAt, startedAt: task.startedAt, completedAt: task.completedAt, steps: task.steps.map(step => ({ key: step.stepKey, status: step.status, attemptCount: step.attemptCount, maxAttempts: step.maxAttempts, lastError: step.lastError })) })) };
}
export async function compensateAutomation(baseUrl: string, types: AutomationTaskType[]) { const service = createAutomationService(baseUrl); const result = await service.engine.compensate(new Date(), types); await service.engine.runAvailable(); return result.map(task => ({ id: task.id, type: task.taskType, status: task.status })); }
