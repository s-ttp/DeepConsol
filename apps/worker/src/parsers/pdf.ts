import pdfParse from "pdf-parse";
import type { ParsedDocument, ParsedSection } from "./index.js";

export async function parsePdf(data: Buffer): Promise<ParsedDocument> {
  const result = await pdfParse(data);
  // pdf-parse joins pages with form-feed (\f). Split on that to keep page boundaries.
  const pages = result.text.split(/\f/);
  const sections: ParsedSection[] = pages
    .map((text, i) => ({
      text: text.trim(),
      source_pointer: `page_${i + 1}`,
      metadata: { page: i + 1, total_pages: pages.length },
    }))
    .filter((s) => s.text.length > 0);
  return { sections };
}
