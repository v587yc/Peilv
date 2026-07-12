import { AutomationEngine } from "./engine";
import { automationHandlers } from "./handlers";
import { SupabaseAutomationRepository } from "./repository";

export function createAutomationService(baseUrl: string): {
  engine: AutomationEngine;
  repository: SupabaseAutomationRepository;
} {
  const repository = new SupabaseAutomationRepository();
  return {
    repository,
    engine: new AutomationEngine({ repository, handlers: automationHandlers, baseUrl }),
  };
}
