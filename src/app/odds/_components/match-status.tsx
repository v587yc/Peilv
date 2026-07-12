"use client";

import {
  CircleCheck,
  CircleHelp,
  Clock3,
  Pause,
  Radio,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type MatchStatusKind = "scheduled" | "live" | "halftime" | "finished" | "unknown";

export type MatchStatus = {
  kind: MatchStatusKind;
  label: string;
  rawState: string;
  Icon: LucideIcon;
};

export function getMatchStatus(rawState: string | null | undefined): MatchStatus {
  const state = rawState ?? "";
  if (state === "0") return { kind: "scheduled", label: "未赛", rawState: state, Icon: Clock3 };
  if (state === "1") return { kind: "live", label: "进行", rawState: state, Icon: Radio };
  if (state === "2") return { kind: "halftime", label: "中场", rawState: state, Icon: Pause };
  if (state === "-1") return { kind: "finished", label: "完场", rawState: state, Icon: CircleCheck };
  return { kind: "unknown", label: "未知", rawState: state, Icon: CircleHelp };
}

export function formatMatchScore(homeScore?: string | null, awayScore?: string | null): string | null {
  const home = homeScore?.trim();
  const away = awayScore?.trim();
  return home && away ? `${home}–${away}` : null;
}

type MatchStatusBadgeProps = {
  state: string | null | undefined;
  className?: string;
};

export function MatchStatusBadge({ state, className }: MatchStatusBadgeProps) {
  const status = getMatchStatus(state);
  const { Icon } = status;
  const rawLabel = status.rawState ? `，原始状态 ${status.rawState}` : "，原始状态为空";

  return (
    <span
      className={cn("match-status-badge", `match-status-badge--${status.kind}`, className)}
      title={status.kind === "unknown" ? `未知赛事状态${rawLabel}` : status.label}
      aria-label={status.kind === "unknown" ? `赛事状态未知${rawLabel}` : `赛事状态：${status.label}`}
    >
      <span className="match-status-badge__icon" aria-hidden="true">
        <Icon />
      </span>
      <span>{status.label}</span>
    </span>
  );
}

type MatchSituationProps = {
  state: string | null | undefined;
  time: string;
  homeScore?: string | null;
  awayScore?: string | null;
  halfHomeScore?: string | null;
  halfAwayScore?: string | null;
  showBadge?: boolean;
  display?: "score" | "time";
  className?: string;
};

export function MatchSituation({
  state,
  time,
  homeScore,
  awayScore,
  halfHomeScore,
  halfAwayScore,
  showBadge = true,
  display = "score",
  className,
}: MatchSituationProps) {
  const status = getMatchStatus(state);
  const score = formatMatchScore(homeScore, awayScore);
  const halfScore = formatMatchScore(halfHomeScore, halfAwayScore);
  const primary = display === "time"
    ? (time || "--")
    : status.kind === "scheduled"
      ? (time || "--")
      : (score || "--");
  const secondary = display === "time"
    ? ""
    : status.kind === "finished"
    ? ["FT", halfScore ? `半 ${halfScore}` : null, time || null].filter(Boolean).join(" · ")
    : status.kind === "halftime"
      ? ["HT", time || null].filter(Boolean).join(" · ")
      : status.kind === "live"
        ? time || "比赛进行中"
        : status.kind === "scheduled"
          ? "开赛时间"
          : time || "状态待确认";

  return (
    <div className={cn("match-situation", className)}>
      {showBadge && <MatchStatusBadge state={state} />}
      <div className="match-situation__data">
        <strong className="match-score">{primary}</strong>
        {secondary && <small>{secondary}</small>}
      </div>
    </div>
  );
}

export function getMatchRowClass(state: string | null | undefined): string {
  return `match-row--${getMatchStatus(state).kind}`;
}
