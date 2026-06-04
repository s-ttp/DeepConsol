import mammoth from "mammoth";
import type { ParsedDocument, ParsedSection } from "./index.js";

export async function parseDocx(data: Buffer): Promise<ParsedDocument> {
  const { value: html } = await mammoth.convertToHtml({ buffer: data });
  // Preserve heading boundaries by splitting on <h1>..<h6>. Strip remaining
  // tags inside each section.
  const parts = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/gi).filter(Boolean);
  const sections: ParsedSection[] = [];
  let currentHeading = "Introduction";
  let buffer: string[] = [];
  let idx = 0;
  const flush = (): void => {
    const text = buffer.join("\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
  for (const p of parts) {
    if (/^<h[1-6]/i.test(p)) {
      flush();
      currentHeading = p.replace(/<[^>]+>/g, "").trim() || currentHeading;
    } else {
      buffer.push(p);
    }
  }
  flush();
  if (sections.length === 0) {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 0) sections.push({ text, source_pointer: "section_1" });
  }
  return { sections };
}
