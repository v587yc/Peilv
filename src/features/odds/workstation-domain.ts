import type { PredictionData } from "./contracts";

export function parsePredictions(json: string): Map<string, PredictionData> {
  const map = new Map<string, PredictionData>();
  if (!json) return map;
  try {
    const parsed: unknown = JSON.parse(json);
    let items: unknown[];
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { matches?: unknown }).matches)) {
      items = (parsed as { matches: unknown[] }).matches;
    } else if (parsed && typeof parsed === "object" && "home" in parsed && "away" in parsed) {
      items = [parsed];
    } else {
      return map;
    }
    for (const value of items) {
      if (!value || typeof value !== "object") continue;
      const item = value as PredictionData;
      if (typeof item.home === "string" && item.home && typeof item.away === "string" && item.away) {
        map.set(`${item.home}_${item.away}`, item);
      }
    }
  } catch {
    // Malformed pasted prediction data is intentionally treated as empty.
  }
  return map;
}

export function normalizeOpenTime(value: string): string {
  if (!value) return "zzz";
  const match = value.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return value;
  return `${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")} ${match[3].padStart(2, "0")}:${match[4]}`;
}

export function formatHandicapLine(line: string): string {
  if (!line) return line;
  const receiving = line.startsWith("*");
  let value = receiving ? line.slice(1) : line;
  if (value.includes("/")) {
    value = value.split("/").map(part => ({ 平: "平手", 半: "半球", 一: "一球", 两: "两球" })[part] ?? part).join("/");
  }
  return receiving ? `受让${value}` : value;
}

export function normalizeMatchDateKey(value: string | undefined | null, fallbackYear = new Date().getFullYear()): string {
  if (!value) return "";
  if (/^\d{8}$/.test(value)) return value;
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}${iso[2].padStart(2, "0")}${iso[3].padStart(2, "0")}`;
  const chinese = value.match(/(\d{1,2})月(\d{1,2})日/);
  if (chinese) return `${fallbackYear}${chinese[1].padStart(2, "0")}${chinese[2].padStart(2, "0")}`;
  return value.replace(/-/g, "");
}

export function previousDateKey(dateKey: string): string {
  if (!/^\d{8}$/.test(dateKey)) return "";
  const date = new Date(Number(dateKey.slice(0, 4)), Number(dateKey.slice(4, 6)) - 1, Number(dateKey.slice(6, 8)));
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}
