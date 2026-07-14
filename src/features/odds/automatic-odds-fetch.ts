import type { MatchData } from "./contracts";
import { isLeagueSelected } from "./league-matching";

export type OddsScheduleMode = "today" | "history" | "future";

export interface AutomaticOddsTargetInput {
  matches: MatchData[];
  selectedLeagues: Set<string>;
  hotLeagues: Set<string>;
  fetchedMatchIds: Set<string>;
  scheduleMode: OddsScheduleMode;
}

export function selectAutomaticOddsTargets({
  matches,
  selectedLeagues,
  hotLeagues,
  fetchedMatchIds,
  scheduleMode,
}: AutomaticOddsTargetInput): MatchData[] {
  return matches.filter(match => {
    if (scheduleMode !== "history" && match.state !== "0") return false;
    if (fetchedMatchIds.has(match.id)) return false;
    if (selectedLeagues.size > 0) return isLeagueSelected(match.league, selectedLeagues);
    return match.isHot === true || hotLeagues.has(match.league);
  });
}

export interface AutomaticOddsRunInput extends AutomaticOddsTargetInput {
  key: string;
  dbReady: boolean;
}

interface AutomaticOddsFetchDependencies {
  fetchMatch(matchId: string, signal: AbortSignal): Promise<boolean>;
  delay?(milliseconds: number): Promise<void>;
}

export function createAutomaticOddsFetchLifecycle(dependencies: AutomaticOddsFetchDependencies) {
  const completedKeys = new Set<string>();
  const delay = dependencies.delay ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let controller: AbortController | null = null;
  let running = false;

  return {
    async run(input: AutomaticOddsRunInput): Promise<{ started: boolean; completed: number }> {
      if (running || !input.dbReady || completedKeys.has(input.key)) return { started: false, completed: 0 };
      const targets = selectAutomaticOddsTargets(input);
      if (targets.length === 0) return { started: false, completed: 0 };

      controller?.abort();
      const current = new AbortController();
      controller = current;
      running = true;
      completedKeys.add(input.key);
      let completed = 0;
      try {
        for (const target of targets) {
          if (current.signal.aborted) break;
          await Promise.allSettled([dependencies.fetchMatch(target.id, current.signal)]);
          completed += 1;
          if (!current.signal.aborted && completed < targets.length) await delay(100);
        }
        return { started: true, completed };
      } finally {
        if (controller === current) controller = null;
        running = false;
      }
    },
    cancel() {
      controller?.abort();
      controller = null;
    },
    reset(key?: string) {
      if (key) completedKeys.delete(key);
      else completedKeys.clear();
    },
    isRunning() {
      return running;
    },
  };
}
