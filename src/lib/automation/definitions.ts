import type { AutomationTaskDefinition, AutomationTaskType } from "./types";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const T30_OFFSET_MS = 30 * 60 * 1000;
const DATE_KEY_PATTERN = /^\d{8}$/;
const MATCH_TIME_PATTERN = /^(?:(?:(\d{1,2})-(\d{1,2}))|(?:(\d{1,2})日))?\s*(\d{1,2}):(\d{2})$/;

export function beijingParts(now: Date): { dateKey: string; hour: number; minute: number } {
  const local = new Date(now.getTime() + BEIJING_OFFSET_MS);
  return {
    dateKey: local.toISOString().slice(0, 10).replace(/-/g, ""),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

export function shiftDateKey(dateKey: string, days: number): string {
  if (!DATE_KEY_PATTERN.test(dateKey)) throw new Error("日期必须是YYYYMMDD格式");
  const date = new Date(Date.UTC(
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(4, 6)) - 1,
    Number(dateKey.slice(6, 8)),
  ));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function today(now: Date): string {
  return beijingParts(now).dateKey;
}

function yesterday(now: Date): string {
  return shiftDateKey(today(now), -1);
}

export const AUTOMATION_DEFINITIONS: Record<AutomationTaskType, AutomationTaskDefinition> = {
  "odds-fetch": {
    type: "odds-fetch",
    hour: 12,
    minute: 2,
    resolveDateKey: today,
    steps: [
      { key: "discover-matches" },
      { key: "fetch-odds", maxAttempts: 3 },
    ],
  },
  "crown-snapshot": {
    type: "crown-snapshot",
    hour: 12,
    minute: 10,
    resolveDateKey: today,
    steps: [
      { key: "discover-matches" },
      { key: "snapshot-crown", maxAttempts: 3 },
    ],
  },
  analysis: {
    type: "analysis",
    hour: 12,
    minute: 15,
    resolveDateKey: today,
    steps: [
      { key: "discover-candidates" },
      { key: "analyze-matches", maxAttempts: 3 },
    ],
  },
  "match-t30-analysis": {
    type: "match-t30-analysis",
    steps: [
      { key: "load-match" },
      { key: "reanalyze-match", maxAttempts: 3 },
    ],
  },
  "verify-learn-report": {
    type: "verify-learn-report",
    hour: 2,
    minute: 0,
    resolveDateKey: yesterday,
    steps: [
      { key: "verify", maxAttempts: 3 },
      { key: "learn", maxAttempts: 3 },
      { key: "report", maxAttempts: 3 },
    ],
  },
};

export function isFixedScheduleDefinition(definition: AutomationTaskDefinition): definition is AutomationTaskDefinition & {
  hour: number;
  minute: number;
  resolveDateKey(now: Date): string;
} {
  return Number.isInteger(definition.hour)
    && Number.isInteger(definition.minute)
    && typeof definition.resolveDateKey === "function";
}

export function isDue(definition: AutomationTaskDefinition, now: Date): boolean {
  if (!isFixedScheduleDefinition(definition)) return false;
  const parts = beijingParts(now);
  return parts.hour > definition.hour || (parts.hour === definition.hour && parts.minute >= definition.minute);
}

export function scheduledAt(definition: AutomationTaskDefinition, now: Date): string {
  if (!isFixedScheduleDefinition(definition)) throw new Error(`动态任务没有固定执行时间: ${definition.type}`);
  const { dateKey } = beijingParts(now);
  const utc = Date.UTC(
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(4, 6)) - 1,
    Number(dateKey.slice(6, 8)),
    definition.hour - 8,
    definition.minute,
  );
  return new Date(utc).toISOString();
}

export function matchKickoffAt(dateKey: string, matchTime: string): Date | null {
  if (!DATE_KEY_PATTERN.test(dateKey)) return null;
  const match = MATCH_TIME_PATTERN.exec(matchTime.trim());
  if (!match) return null;

  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  const displayedMonth = match[1] ? Number(match[1]) : null;
  const displayedDay = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : null;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (displayedMonth !== null && displayedMonth !== month) return null;
  if (displayedDay !== null && displayedDay !== day) return null;
  if (hour > 23 || minute > 59) return null;

  const dateCheck = new Date(Date.UTC(year, month - 1, day));
  if (dateCheck.getUTCFullYear() !== year || dateCheck.getUTCMonth() !== month - 1 || dateCheck.getUTCDate() !== day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

export function matchT30ScheduledAt(dateKey: string, matchTime: string): Date | null {
  const kickoff = matchKickoffAt(dateKey, matchTime);
  return kickoff ? new Date(kickoff.getTime() - T30_OFFSET_MS) : null;
}

export function taskIdempotencyKey(
  type: AutomationTaskType,
  dateKey: string,
  source = "production",
  matchId?: string | null,
): string {
  if (type === "match-t30-analysis") {
    if (!matchId) throw new Error("赛前30分钟任务必须包含matchId");
    return `automation:${source}:${type}:${matchId}`;
  }
  return `automation:${source}:${type}:${dateKey}`;
}

export function stepIdempotencyKey(taskKey: string, stepKey: string): string {
  return `${taskKey}:${stepKey}`;
}
