import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createExcelExportBlob } from "@/features/odds/excel-export-client";
import {
  EXCEL_EXPORT_MIME,
  buildExcelExportDocument,
  decideExcelExportRows,
  sanitizeExcelText,
  type ExcelExportRow,
} from "@/features/odds/excel-export-document";

async function inspectOoxml(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const zip = await JSZip.loadAsync(bytes);
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const worksheet = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
  const sharedStrings = await zip.file("xl/sharedStrings.xml")?.async("string");
  return { bytes, zip, workbook: workbook ?? "", worksheet: worksheet ?? "", sharedStrings: sharedStrings ?? "" };
}

describe("Excel export security document", () => {
  it("preserves first-seen columns and makes formula-looking input plain strings", async () => {
    const document = buildExcelExportDocument([
      { 联赛: "中超 & 青年<组>", 主队: "=HYPERLINK(\"https://bad.example\")", 备注: "正常\u0001文本" },
      { 联赛: "英超", 主队: "+SUM(1,1)", 客队: "@危险" },
    ], "20260719");

    expect(document).toEqual({
      filename: "赔率数据_20260719.xlsx",
      sheetName: "赔率数据",
      columns: ["联赛", "主队", "备注", "客队"],
      rows: [
        ["中超 & 青年<组>", "=HYPERLINK(\"https://bad.example\")", "正常�文本", ""],
        ["英超", "+SUM(1,1)", "", "@危险"],
      ],
    });

    const blob = await createExcelExportBlob(document);
    expect(blob.type).toBe(EXCEL_EXPORT_MIME);
    const inspected = await inspectOoxml(blob);
    expect(Array.from(inspected.bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(inspected.zip.file("[Content_Types].xml")).not.toBeNull();
    expect(inspected.workbook).toContain("赔率数据");
    expect(inspected.worksheet).not.toContain("<f>");
    expect(inspected.sharedStrings).toContain("中超 &amp; 青年&lt;组&gt;");
    expect(inspected.sharedStrings).toContain("=HYPERLINK(&quot;https://bad.example&quot;)");
    expect(inspected.sharedStrings).not.toContain("\u0001");
  });

  it("enforces explicit row safety decisions", () => {
    expect(decideExcelExportRows(50_000)).toEqual({ allowed: true });
    expect(decideExcelExportRows(50_001)).toMatchObject({ allowed: false });
    expect(decideExcelExportRows(100_000)).toMatchObject({ allowed: false });
    expect(decideExcelExportRows(100_001)).toMatchObject({ allowed: false });
    expect(() => buildExcelExportDocument(Array.from({ length: 50_001 }, () => ({ a: "x" })), "large")).toThrow("50,000");
    expect(sanitizeExcelText("中文<&\u0000")).toBe("中文<&�");
  });

  it("serializes the 10k-row PR performance fixture within budget", async () => {
    const rows: ExcelExportRow[] = Array.from({ length: 10_000 }, (_, index) => ({
      日期: "20260719",
      联赛: `测试联赛${index % 20}`,
      主队: `主队${index}`,
      客队: `客队${index}`,
      公司: index % 2 ? "皇冠" : "盈禾",
      "亚盘(初)盘口": index % 3 ? "半球" : "平手/半球",
    }));
    const start = performance.now();
    const blob = await createExcelExportBlob(buildExcelExportDocument(rows, "perf-10k"));
    const elapsedMs = performance.now() - start;
    const inspected = await inspectOoxml(blob);

    expect(inspected.worksheet).toContain('r="10001"');
    expect(blob.size).toBeGreaterThan(100_000);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 20_000);
});
