import * as cheerio from "cheerio";
import type { ParsedDocument, ParsedSection } from "./index.js";

export async function parseHtml(data: Buffer): Promise<ParsedDocument> {
  const $ = cheerio.load(data.toString("utf-8"));
  $("script, style, noscript").remove();

  const sections: ParsedSection[] = [];
  let currentHeading = "Document";
  let buffer: string[] = [];
  let idx = 0;
  const flush = (): void => {
    const text = buffer.join("\n").replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      idx += 1;
      sections.push({
        text,
        source_pointer: `section_${idx}`,
        metadata: { heading: currentHeading },
      });
    }
    buffer = [];
  };
  $("body").find("*").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (tag && /^h[1-6]$/.test(tag)) {
      flush();
      currentHeading = $(el).text().trim() || currentHeading;
    } else if (tag && /^(p|li|td|th|pre|code|blockquote)$/.test(tag)) {
      const txt = $(el).text().trim();
      if (txt) buffer.push(txt);
    }
  });
  flush();
  if (sections.length === 0) {
    const text = $("body").text().replace(/\s+/g, " ").trim();
    if (text.length > 0) sections.push({ text, source_pointer: "section_1" });
  }
  return { sections };
}
