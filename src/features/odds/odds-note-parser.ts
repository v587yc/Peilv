import type { OddsComparison } from "./contracts";

const CHINESE_LINE_VALUES: Record<string, number> = {
  零: 0,
  平: 0,
  半: 0.5,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

const LINE_WORD_VALUES: Record<string, number> = {
  平手: 0,
  半球: 0.5,
  一球: 1,
  一球半: 1.5,
  两球: 2,
  两球半: 2.5,
  三球: 3,
  三球半: 3.5,
  四球: 4,
  四球半: 4.5,
};

export function extractOddsPairFromNote(
  note: string,
): { homeOdds: number; awayOdds: number } | null {
  if (!note) return null;

  const match = note.match(/(\d+\.\d+)\s*\/\s*(\d+\.\d+)/);
  if (!match) return null;

  const homeOdds = parseFloat(match[1]);
  const awayOdds = parseFloat(match[2]);
  return !isNaN(homeOdds) && !isNaN(awayOdds) ? { homeOdds, awayOdds } : null;
}

export function detectHandicapSide(note: string): "home" | "away" | null {
  if (/主|受让|受/.test(note) && !/客/.test(note)) return "home";
  if (/客|让球|让$|^[让]/.test(note) && !/主/.test(note)) return "away";
  return null;
}

export function detectTotalSide(note: string): "over" | "under" | null {
  if (/大/.test(note) && !/小/.test(note)) return "over";
  if (/小/.test(note) && !/大/.test(note)) return "under";
  return null;
}

export function extractLineFromNote(note: string): string {
  if (!note) return "";

  const oddsMatch = note.match(/(\d+\.\d+)\s*\/\s*(\d+\.\d+)/);
  if (!oddsMatch) return "";
  return note.substring(0, oddsMatch.index).trim().replace(/\s+$/, "");
}

export function parseHandicapNote(
  note: string,
): { line: string; homeOdds: string; awayOdds: string; side: string } | null {
  if (!note) return null;

  const oddsPair = extractOddsPairFromNote(note);
  if (!oddsPair) return null;
  const detected = detectHandicapSide(note);
  return {
    line: extractLineFromNote(note),
    homeOdds: oddsPair.homeOdds.toFixed(2),
    awayOdds: oddsPair.awayOdds.toFixed(2),
    side: detected === "home" ? "主" : detected === "away" ? "客" : "",
  };
}

export function parseTotalNote(
  note: string,
): { line: string; overOdds: string; underOdds: string; side: string } | null {
  if (!note) return null;

  const oddsPair = extractOddsPairFromNote(note);
  if (!oddsPair) return null;
  const detected = detectTotalSide(note);
  return {
    line: extractLineFromNote(note),
    overOdds: oddsPair.homeOdds.toFixed(2),
    underOdds: oddsPair.awayOdds.toFixed(2),
    side: detected === "over" ? "大" : detected === "under" ? "小" : "",
  };
}

export function getHandicapTrendLabel(
  initLine: number,
  liveLine: number,
): "升" | "降" | null {
  const diff = liveLine - initLine;
  if (Math.abs(diff) < 0.01) return null;
  return initLine >= 0 ? (diff > 0 ? "升" : "降") : (diff < 0 ? "升" : "降");
}

export function lineTextToNumber(text: string): number | null {
  if (!text) return null;

  const normalized = text.trim();
  const numeric = parseFloat(normalized);
  if (!isNaN(numeric)) return numeric;

  const receiving = normalized.startsWith("受") || normalized.startsWith("*");
  const body = receiving ? normalized.slice(1) : normalized;
  const bodyNumeric = parseFloat(body);
  if (!isNaN(bodyNumeric)) return receiving ? -bodyNumeric : bodyNumeric;

  const parts = body.split("/");
  if (parts.length === 2) {
    const low = LINE_WORD_VALUES[parts[0]] ?? parseFloat(parts[0]);
    const high = LINE_WORD_VALUES[parts[1]] ?? parseFloat(parts[1]);
    if (!isNaN(low) && !isNaN(high)) {
      return receiving ? -(low + high) / 2 : (low + high) / 2;
    }

    const values = parts.map((part) => (
      [...part].reduce((sum, char) => sum + (CHINESE_LINE_VALUES[char] ?? 0), 0)
    ));
    return receiving ? -(values[0] + values[1]) / 2 : (values[0] + values[1]) / 2;
  }

  if (LINE_WORD_VALUES[body] !== undefined) {
    return receiving ? -LINE_WORD_VALUES[body] : LINE_WORD_VALUES[body];
  }
  const value = [...body].reduce(
    (sum, char) => sum + (CHINESE_LINE_VALUES[char] ?? 0),
    0,
  );
  return receiving ? -value : value;
}

export function computeCrown12VsLiveDiff(
  crown12: {
    handicapHome?: string | null;
    handicapLine?: string | null;
    handicapAway?: string | null;
  },
  liveHomeOdds: string,
  liveAwayOdds: string,
  liveHandicapRaw: number,
): { homeDiff: number; awayDiff: number; lineChange: number } | null {
  if (!crown12.handicapHome || !crown12.handicapAway || !crown12.handicapLine) {
    return null;
  }

  const c12Home = parseFloat(crown12.handicapHome);
  const c12Away = parseFloat(crown12.handicapAway);
  const liveHome = parseFloat(liveHomeOdds);
  const liveAway = parseFloat(liveAwayOdds);
  if ([c12Home, c12Away, liveHome, liveAway].some(isNaN)) return null;

  const c12Line = lineTextToNumber(crown12.handicapLine);
  if (c12Line === null) return null;
  return {
    homeDiff: parseFloat((liveHome - c12Home).toFixed(2)),
    awayDiff: parseFloat((liveAway - c12Away).toFixed(2)),
    lineChange: parseFloat((liveHandicapRaw - c12Line).toFixed(2)),
  };
}

export function computeHandicapComparison(
  noteText: string,
  homeOdds: string,
  awayOdds: string,
  baseTotal = 1.90,
): OddsComparison | null {
  const pair = extractOddsPairFromNote(noteText);
  if (!pair) return null;

  const home = parseFloat(homeOdds);
  const away = parseFloat(awayOdds);
  if (isNaN(home) || isNaN(away)) return null;

  const side = detectHandicapSide(noteText);
  if (side === "home") {
    const sumTotal = pair.homeOdds + away;
    return {
      predictedOdds: pair.homeOdds,
      currentOdds: away,
      sumTotal,
      diff: sumTotal - baseTotal,
    };
  }
  if (side === "away") {
    const sumTotal = pair.awayOdds + home;
    return {
      predictedOdds: pair.awayOdds,
      currentOdds: home,
      sumTotal,
      diff: sumTotal - baseTotal,
    };
  }
  return null;
}

export function computeTotalComparison(
  noteText: string,
  overOdds: string,
  underOdds: string,
  baseTotal = 1.90,
): OddsComparison | null {
  const pair = extractOddsPairFromNote(noteText);
  if (!pair) return null;

  const over = parseFloat(overOdds);
  const under = parseFloat(underOdds);
  if (isNaN(over) || isNaN(under)) return null;

  const side = detectTotalSide(noteText);
  if (side === "over") {
    const sumTotal = pair.homeOdds + under;
    return {
      predictedOdds: pair.homeOdds,
      currentOdds: under,
      sumTotal,
      diff: sumTotal - baseTotal,
    };
  }
  if (side === "under") {
    const sumTotal = pair.awayOdds + over;
    return {
      predictedOdds: pair.awayOdds,
      currentOdds: over,
      sumTotal,
      diff: sumTotal - baseTotal,
    };
  }
  return null;
}
