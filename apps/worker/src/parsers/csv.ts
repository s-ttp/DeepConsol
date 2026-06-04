import { parse } from "csv-parse/sync";
import type { ParsedDocument, ParsedSection } from "./index.js";

const ROWS_PER_CHUNK = 100;

export async function parseCsv(data: Buffer): Promise<ParsedDocument> {
  const records = parse(data, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  }) as string[][];
  if (records.length === 0) return { sections: [] };
  const header = records[0];
  const sections: ParsedSection[] = [];
  for (let i = 1; i < records.length; i += ROWS_PER_CHUNK) {
    const slice = records.slice(i, i + ROWS_PER_CHUNK);
    const lines = [header.join(" | "), "---", ...slice.map((r) => r.join(" | "))];
    sections.push({
      text: lines.join("\n"),
      source_pointer: `rows_${i + 1}-${i + slice.length}`,
      metadata: { header },
    });
  }
  return { sections };
}
