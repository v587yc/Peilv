export const EXCEL_EXPORT_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const EXCEL_EXPORT_NORMAL_ROW_LIMIT = 50_000;
export const EXCEL_EXPORT_ABSOLUTE_ROW_LIMIT = 100_000;

export type ExcelExportCell = string | number;
export type ExcelExportRow = Record<string, ExcelExportCell>;

export type ExcelExportDocument = {
  filename: string;
  sheetName: string;
  columns: string[];
  rows: ExcelExportCell[][];
};

export type ExcelExportRowDecision =
  | { allowed: true }
  | { allowed: false; message: string };

const INVALID_XML_10_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

export function sanitizeExcelText(value: string): string {
  return value.replace(INVALID_XML_10_CHARACTERS, "\ufffd");
}

export function decideExcelExportRows(rowCount: number): ExcelExportRowDecision {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    return { allowed: false, message: "导出行数无效，请刷新数据后重试" };
  }
  if (rowCount > EXCEL_EXPORT_ABSOLUTE_ROW_LIMIT) {
    return { allowed: false, message: `导出已阻断：${rowCount.toLocaleString("zh-CN")} 行超过 100,000 行安全上限` };
  }
  if (rowCount > EXCEL_EXPORT_NORMAL_ROW_LIMIT) {
    return { allowed: false, message: `导出已阻断：${rowCount.toLocaleString("zh-CN")} 行超过 50,000 行安全上限，请缩小日期或联赛范围` };
  }
  return { allowed: true };
}

function normalizeCell(value: ExcelExportCell | null | undefined): ExcelExportCell {
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  return sanitizeExcelText(value == null ? "" : String(value));
}

export function buildExcelExportDocument(
  rows: readonly ExcelExportRow[],
  dateRange: string,
): ExcelExportDocument {
  const decision = decideExcelExportRows(rows.length);
  if (!decision.allowed) throw new Error(decision.message);

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(sanitizeExcelText(key));
    }
  }

  return {
    filename: `赔率数据_${sanitizeExcelText(dateRange)}.xlsx`,
    sheetName: "赔率数据",
    columns,
    rows: rows.map(row => columns.map(column => normalizeCell(row[column]))),
  };
}
