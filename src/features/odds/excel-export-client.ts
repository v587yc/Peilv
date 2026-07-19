import type { ExcelExportDocument } from "./excel-export-document";
import { EXCEL_EXPORT_MIME } from "./excel-export-document";

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

export async function createExcelExportBlob(document: ExcelExportDocument): Promise<Blob> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "赔率监控系统";
  workbook.created = new Date(0);
  workbook.modified = new Date(0);

  const worksheet = workbook.addWorksheet(document.sheetName);
  worksheet.addRow(document.columns);
  for (const row of document.rows) worksheet.addRow(row);

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = Uint8Array.from(buffer as unknown as ArrayLike<number>);
  return new Blob([bytes], { type: EXCEL_EXPORT_MIME });
}

export async function downloadExcelExport(document: ExcelExportDocument): Promise<void> {
  const blob = await createExcelExportBlob(document);
  downloadBlob(blob, document.filename);
}
