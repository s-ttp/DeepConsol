import ExcelJS from "exceljs";
import type { ParsedDocument, ParsedSection } from "./index.js";

const ROWS_PER_CHUNK = 50;

export async function parseXlsx(data: Buffer): Promise<ParsedDocument> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const sections: ParsedSection[] = [];

  for (const sheet of wb.worksheets) {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        let s = "";
        if (v === null || v === undefined) s = "";
        else if (typeof v === "object" && "richText" in v && Array.isArray((v as { richText: unknown[] }).richText)) {
          s = (v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join("");
        } else if (typeof v === "object" && "text" in v) {
          s = String((v as { text: unknown }).text ?? "");
        } else if (typeof v === "object" && "result" in v) {
          s = String((v as { result: unknown }).result ?? "");
        } else if (v instanceof Date) {
          s = v.toISOString();
        } else {
          s = String(v);
        }
        cells.push(s);
      });
      rows.push(cells);
    });
    if (rows.length === 0) continue;
    const header = rows[0];
    for (let i = 1; i < rows.length; i += ROWS_PER_CHUNK) {
      const slice = rows.slice(i, i + ROWS_PER_CHUNK);
      const lines = [header.join(" | "), "---", ...slice.map((r) => r.join(" | "))];
      sections.push({
        text: lines.join("\n"),
        source_pointer: `sheet_${sheet.name}/rows_${i + 1}-${Math.min(i + slice.length, rows.length - 1) + 1}`,
        metadata: { sheet: sheet.name, header },
      });
    }
  }
  return { sections };
}
