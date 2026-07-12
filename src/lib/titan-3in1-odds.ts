export interface ThreeInOneLatestOdds {
  handicapHome: string;
  handicapLine: string;
  handicapAway: string;
  totalOver: string;
  totalLine: string;
  totalUnder: string;
  euroHome: string;
  euroDraw: string;
  euroAway: string;
  handicapObservedAt: string;
  totalObservedAt: string;
  euroObservedAt: string;
}

interface ThreeInOneRow {
  left: string;
  line: string;
  right: string;
  observedAt: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function cleanCell(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(table: string): string[] {
  return table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
}

function rowCells(row: string): string[] {
  return (row.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || []).map(cleanCell);
}

function parseLatestFullTimeRow(table: string): ThreeInOneRow | null {
  for (const row of tableRows(table)) {
    const cells = rowCells(row);
    if (cells.length < 7) continue;
    if (cells[0] !== "" || cells[1] !== "-") continue;
    if (!cells[2] || !cells[3] || !cells[4]) continue;

    return {
      left: cells[2],
      line: cells[3],
      right: cells[4],
      observedAt: cells[5] || "",
    };
  }

  return null;
}

export function parseThreeInOneLatestOdds(html: string): ThreeInOneLatestOdds | null {
  const tables = html.match(/<table\b[^>]*class=["'][^"']*\bgts\b[^"']*["'][^>]*>[\s\S]*?<\/table>/gi) || [];
  if (tables.length < 3) return null;

  const [handicapTable, totalTable, euroTable] = tables as [string, string, string, ...string[]];
  const handicap = parseLatestFullTimeRow(handicapTable);
  const total = parseLatestFullTimeRow(totalTable);
  const euro = parseLatestFullTimeRow(euroTable);
  if (!handicap && !total && !euro) return null;

  return {
    handicapHome: handicap?.left || "",
    handicapLine: handicap?.line || "",
    handicapAway: handicap?.right || "",
    totalOver: total?.left || "",
    totalLine: total?.line || "",
    totalUnder: total?.right || "",
    euroHome: euro?.left || "",
    euroDraw: euro?.line || "",
    euroAway: euro?.right || "",
    handicapObservedAt: handicap?.observedAt || "",
    totalObservedAt: total?.observedAt || "",
    euroObservedAt: euro?.observedAt || "",
  };
}
