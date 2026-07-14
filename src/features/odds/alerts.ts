export interface AlertConfig {
  matchId: string;
  handicapUp: string;
  handicapDown: string;
  totalLineUp: string;
  totalLineDown: string;
  homeOddsUp: string;
  homeOddsDown: string;
  awayOddsUp: string;
  awayOddsDown: string;
  overOddsUp: string;
  overOddsDown: string;
  underOddsUp: string;
  underOddsDown: string;
}

export interface AlertItem { id: string; message: string; time: number }
export interface OddsSnapshot { handicapRaw: number; totalLineRaw: number; homeOdds: string; awayOdds: string; overOdds: string; underOdds: string }
type AlertMatch = OddsSnapshot & { id: string; homeTeam: string; awayTeam: string };

export function createOddsAlerts(input: {
  configs: ReadonlyMap<string, AlertConfig>;
  snapshots: ReadonlyMap<string, OddsSnapshot>;
  matches: readonly AlertMatch[];
  now: number;
  seen?: Set<string>;
}): AlertItem[] {
  const alerts: AlertItem[] = [];
  for (const config of input.configs.values()) {
    const match = input.matches.find(item => item.id === config.matchId);
    const snapshot = input.snapshots.get(config.matchId);
    if (!match || !snapshot) continue;
    const thresholds = [
      { value: match.handicapRaw - snapshot.handicapRaw, up: config.handicapUp, down: config.handicapDown, label: "让球" },
      { value: match.totalLineRaw - snapshot.totalLineRaw, up: config.totalLineUp, down: config.totalLineDown, label: "大小球" },
      { value: Number(match.homeOdds) - Number(snapshot.homeOdds), up: config.homeOddsUp, down: config.homeOddsDown, label: "主队赔率" },
      { value: Number(match.awayOdds) - Number(snapshot.awayOdds), up: config.awayOddsUp, down: config.awayOddsDown, label: "客队赔率" },
      { value: Number(match.overOdds) - Number(snapshot.overOdds), up: config.overOddsUp, down: config.overOddsDown, label: "大球赔率" },
      { value: Number(match.underOdds) - Number(snapshot.underOdds), up: config.underOddsUp, down: config.underOddsDown, label: "小球赔率" },
    ];
    for (const threshold of thresholds) {
      const normalizedValue = Number(threshold.value.toFixed(10));
      const up = Number.parseFloat(threshold.up);
      const down = Number.parseFloat(threshold.down);
      const direction = Number.isFinite(up) && up > 0 && normalizedValue >= up ? "up" : Number.isFinite(down) && down > 0 && normalizedValue <= -down ? "down" : null;
      if (!direction) continue;
      const observationKey = `${config.matchId}:${threshold.label}:${direction}:${normalizedValue.toFixed(4)}`;
      if (input.seen?.has(observationKey)) continue;
      input.seen?.add(observationKey);
      alerts.push({
        id: `${config.matchId}-${threshold.label}-${direction}-${input.now}`,
        message: `${match.homeTeam} vs ${match.awayTeam} ${threshold.label} ${direction === "up" ? "升了" : "降了"} ${Math.abs(normalizedValue).toFixed(2)}`,
        time: input.now,
      });
    }
  }
  return alerts;
}

export function shouldPlayThresholdAlert(total: number, threshold: number, previous: number): boolean {
  return total > threshold && total > previous;
}

export type SoundPort = { play(): void };
export function notifyAlerts(alerts: readonly AlertItem[], enabled: boolean, sound?: SoundPort): boolean {
  if (alerts.length === 0 || !enabled) return false;
  sound?.play();
  return true;
}
