import { parsePdf } from "./pdf.js";
import { parseDocx } from "./docx.js";
import { parsePptx } from "./pptx.js";
import { parseXlsx } from "./xlsx.js";
import { parseCsv } from "./csv.js";
import { parseHtml } from "./html.js";
import { parseTxt } from "./txt.js";

export interface ParsedSection {
  text: string;
  source_pointer: string; // e.g. "page_12", "slide_3", "sheet_Sales/range_A1:H50"
  metadata?: Record<string, unknown>;
}

export interface ParsedDocument {
  sections: ParsedSection[];
}

export async function parseDocument(
  filename: string,
  mime: string,
  data: Buffer
): Promise<ParsedDocument> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const lowMime = mime.toLowerCase();

  if (ext === "pdf" || lowMime.includes("pdf")) {
    return parsePdf(data);
  }
  if (ext === "docx" || lowMime.includes("officedocument.wordprocessingml")) {
    return parseDocx(data);
  }
  if (ext === "pptx" || lowMime.includes("officedocument.presentationml")) {
    return parsePptx(data);
  }
  if (ext === "xlsx" || ext === "xls" || lowMime.includes("spreadsheetml") || lowMime.includes("ms-excel")) {
    return parseXlsx(data);
  }
  if (ext === "csv" || lowMime.includes("text/csv")) {
    return parseCsv(data);
  }
  if (ext === "html" || ext === "htm" || lowMime.includes("text/html")) {
    return parseHtml(data);
  }
  if (ext === "txt" || ext === "log" || ext === "md" || lowMime.startsWith("text/")) {
    return parseTxt(data);
  }
  throw new Error(`Unsupported file type: ext="${ext}" mime="${mime}"`);
}
