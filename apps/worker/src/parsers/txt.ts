import type { ParsedDocument, ParsedSection } from "./index.js";

export async function parseTxt(data: Buffer): Promise<ParsedDocument> {
  const text = data.toString("utf-8");
  // Try to split on markdown-style headings; fall back to one big section.
  const parts = text.split(/(^#{1,6}\s+.+$)/m);
  const sections: ParsedSection[] = [];
  let currentHeading = "Document";
  let buffer: string[] = [];
  let idx = 0;
  const flush = (): void => {
    const t = buffer.join("\n").trim();
    if (t.length > 0) {
      idx += 1;
      sections.push({
        text: t,
        source_pointer: `section_${idx}`,
        metadata: { heading: currentHeading },
      });
    }
    buffer = [];
  };
  for (const p of parts) {
    if (/^#{1,6}\s+/.test(p)) {
      flush();
      currentHeading = p.replace(/^#{1,6}\s+/, "").trim() || currentHeading;
    } else if (p) {
      buffer.push(p);
    }
  }
  flush();
  if (sections.length === 0 && text.trim().length > 0) {
    sections.push({ text: text.trim(), source_pointer: "section_1" });
  }
  return { sections };
}
