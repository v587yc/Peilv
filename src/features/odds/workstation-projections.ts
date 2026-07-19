import type { MatchData, MatchNotes } from "./contracts";
import { computeHandicapComparison, computeTotalComparison } from "./odds-note-parser";

export type WorkstationOtherMatchFilter = "all" | "live" | "halftime" | "finished" | "unknown";
export type WorkstationStatusKind = "scheduled" | Exclude<WorkstationOtherMatchFilter, "all">;

export function projectScheduledMatches(input: {
  matches: readonly MatchData[];
  selectedLeagues: ReadonlySet<string>;
  minimumOddsSum: number;
  pinnedMatchIds: ReadonlySet<string>;
}): MatchData[] {
  return input.matches
    .filter(match => match.state === "0")
    .filter(match => input.selectedLeagues.size === 0 || input.selectedLeagues.has(match.league))
    .filter(match => {
      if (input.minimumOddsSum <= 0) return true;
      const home = Number.parseFloat(match.homeOdds);
      const away = Number.parseFloat(match.awayOdds);
      return Number.isFinite(home) && Number.isFinite(away) && home + away > input.minimumOddsSum;
    })
    .sort((left, right) => {
      const pinOrder = Number(!input.pinnedMatchIds.has(left.id)) - Number(!input.pinnedMatchIds.has(right.id));
      return pinOrder || left.orderIndex - right.orderIndex;
    });
}

export function projectOtherMatches(input: {
  matches: readonly MatchData[];
  selectedLeagues: ReadonlySet<string>;
  pinnedMatchIds: ReadonlySet<string>;
  filter: WorkstationOtherMatchFilter;
  statusKind(state: string): WorkstationStatusKind;
}): {
  all: MatchData[];
  visible: MatchData[];
  counts: Record<WorkstationOtherMatchFilter, number>;
} {
  const priority: Record<Exclude<WorkstationStatusKind, "scheduled">, number> = {
    live: 0,
    halftime: 1,
    finished: 2,
    unknown: 3,
  };
  const all = input.matches
    .filter(match => match.state !== "0")
    .filter(match => input.selectedLeagues.size === 0 || input.selectedLeagues.has(match.league))
    .sort((left, right) => {
      const pinOrder = Number(!input.pinnedMatchIds.has(left.id)) - Number(!input.pinnedMatchIds.has(right.id));
      if (pinOrder) return pinOrder;
      const leftKind = input.statusKind(left.state);
      const rightKind = input.statusKind(right.state);
      const statusOrder = (leftKind === "scheduled" ? 99 : priority[leftKind]) - (rightKind === "scheduled" ? 99 : priority[rightKind]);
      return statusOrder || left.orderIndex - right.orderIndex;
    });
  const counts: Record<WorkstationOtherMatchFilter, number> = { all: all.length, live: 0, halftime: 0, finished: 0, unknown: 0 };
  for (const match of all) {
    const kind = input.statusKind(match.state);
    if (kind !== "scheduled") counts[kind] += 1;
  }
  return {
    all,
    visible: input.filter === "all" ? all : all.filter(match => input.statusKind(match.state) === input.filter),
    counts,
  };
}

export interface OddsComparisonDetail {
  matchId: string;
  home: string;
  away: string;
  league: string;
  type: "handicap" | "total";
  predictedOdds: number;
  currentOdds: number;
  sumTotal: number;
  diff: number;
}

export function buildOddsComparisonSummary(input: {
  matches: readonly MatchData[];
  notes: ReadonlyMap<string, MatchNotes>;
  oddsBaseTotal: number;
}): { totalDiff: number; matchCount: number; details: OddsComparisonDetail[] } {
  let totalDiff = 0;
  const details: OddsComparisonDetail[] = [];
  for (const match of input.matches) {
    if (match.state !== "0") continue;
    const notes = input.notes.get(match.id);
    if (!notes) continue;
    const comparisons = [
      notes.handicapNote && !notes.handicapSettled
        ? { type: "handicap" as const, value: computeHandicapComparison(notes.handicapNote, match.homeOdds, match.awayOdds, input.oddsBaseTotal) }
        : null,
      notes.totalNote && !notes.totalSettled
        ? { type: "total" as const, value: computeTotalComparison(notes.totalNote, match.overOdds, match.underOdds, input.oddsBaseTotal) }
        : null,
    ];
    for (const comparison of comparisons) {
      if (!comparison?.value) continue;
      totalDiff += comparison.value.diff;
      details.push({
        matchId: match.id,
        home: match.homeTeam,
        away: match.awayTeam,
        league: match.league,
        type: comparison.type,
        ...comparison.value,
      });
    }
  }
  return { totalDiff, matchCount: details.length, details };
}
