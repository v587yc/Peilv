import { AUTOMATION_DEFINITIONS, matchKickoffAt, matchT30ScheduledAt } from "./definitions";
import type { AutomationRepository, CreateTaskInput, TaskWithSteps } from "./types";

export interface MatchT30Metadata {
  matchId: string;
  matchDate: string;
  matchTime: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  scheduleMode?: string;
}

export function buildMatchT30TaskInput(
  match: MatchT30Metadata,
  now = new Date(),
): CreateTaskInput | null {
  if (!match.matchId || !/^\d{8}$/.test(match.matchDate)) return null;
  const kickoff = matchKickoffAt(match.matchDate, match.matchTime);
  const triggerAt = matchT30ScheduledAt(match.matchDate, match.matchTime);
  if (!kickoff || !triggerAt || kickoff <= now) return null;

  return {
    taskType: "match-t30-analysis",
    source: "production",
    dateKey: match.matchDate,
    matchId: match.matchId,
    scheduledAt: triggerAt.toISOString(),
    payload: {
      trigger: "match-t30",
      kickoffAt: kickoff.toISOString(),
      matchTime: match.matchTime,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      league: match.league,
      scheduleMode: match.scheduleMode || "future",
    },
  };
}

export async function upsertMatchT30Task(
  repository: AutomationRepository,
  match: MatchT30Metadata,
  now = new Date(),
): Promise<TaskWithSteps | null> {
  const input = buildMatchT30TaskInput(match, now);
  if (!input) return null;
  return repository.createOrReschedule(input, AUTOMATION_DEFINITIONS["match-t30-analysis"]);
}
