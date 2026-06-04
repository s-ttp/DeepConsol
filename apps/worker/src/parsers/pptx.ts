import JSZip from "jszip";
import { parseStringPromise } from "xml2js";
import type { ParsedDocument, ParsedSection } from "./index.js";

interface XmlNode {
  [k: string]: unknown;
  "a:t"?: Array<string | XmlNode>;
}

function collectText(node: XmlNode | null | undefined, out: string[]): void {
  if (!node) return;
  if (Array.isArray(node["a:t"])) {
    for (const t of node["a:t"]) {
      if (typeof t === "string") out.push(t);
      else if (t && typeof t === "object" && "_" in t && typeof (t as { _: unknown })._ === "string") {
        out.push((t as { _: string })._);
      }
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "a:t" || k === "$") continue;
    if (Array.isArray(v)) {
      for (const child of v) {
        if (child && typeof child === "object") collectText(child as XmlNode, out);
      }
    } else if (v && typeof v === "object") {
      collectText(v as XmlNode, out);
    }
  }
}

export async function parsePptx(data: Buffer): Promise<ParsedDocument> {
  const zip = await JSZip.loadAsync(data);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const an = parseInt(a.match(/slide(\d+)/)?.[1] ?? "0", 10);
      const bn = parseInt(b.match(/slide(\d+)/)?.[1] ?? "0", 10);
      return an - bn;
    });

  const sections: ParsedSection[] = [];
  for (const name of slideNames) {
    const slideNumber = parseInt(name.match(/slide(\d+)/)?.[1] ?? "0", 10);
    const xml = await zip.files[name].async("string");
    const parsed = (await parseStringPromise(xml)) as XmlNode;
    const out: string[] = [];
    collectText(parsed, out);

    let notesText = "";
    const notesName = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
    if (zip.files[notesName]) {
      const notesXml = await zip.files[notesName].async("string");
      const notesParsed = (await parseStringPromise(notesXml)) as XmlNode;
      const notesOut: string[] = [];
      collectText(notesParsed, notesOut);
      notesText = notesOut.join("\n").trim();
    }

    const text = [out.join("\n"), notesText ? `Notes:\n${notesText}` : ""]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (text.length > 0) {
      sections.push({
        text,
        source_pointer: `slide_${slideNumber}`,
        metadata: { slide: slideNumber, has_notes: notesText.length > 0 },
      });
    }
  }
  return { sections };
}
