import type { ParsedSection } from "./parsers/index.js";

const APPROX_CHARS_PER_TOKEN = 4;

export interface Chunk {
  text: string;
  source_pointer: string;
  metadata: Record<string, unknown>;
  chunk_index: number;
}

/**
 * Token-aware chunker. We don't depend on a tokenizer library; using ~4
 * chars/token works well enough for English mixed with config snippets.
 *
 * Rules:
 *  - Each input section is treated as a hard break (don't bleed across pages,
 *    slides, or sheet ranges).
 *  - Within a section, we split on paragraph boundaries first, then on
 *    sentences, then on hard cuts when a single sentence is huge.
 */
export function chunkSections(
  sections: ParsedSection[],
  targetTokens: number,
  overlapTokens: number
): Chunk[] {
  const targetChars = targetTokens * APPROX_CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * APPROX_CHARS_PER_TOKEN;
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const paras = section.text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
    let buffer = "";
    for (const para of paras) {
      const candidate = buffer.length === 0 ? para : `${buffer}\n\n${para}`;
      if (candidate.length <= targetChars) {
        buffer = candidate;
        continue;
      }
      if (buffer.length > 0) {
        chunks.push({ text: buffer, source_pointer: section.source_pointer, metadata: section.metadata ?? {}, chunk_index: chunkIndex++ });
        const tail = buffer.slice(Math.max(0, buffer.length - overlapChars));
        buffer = tail.length > 0 ? `${tail}\n\n${para}` : para;
      } else {
        // Single paragraph too big; hard-split.
        for (let i = 0; i < para.length; i += targetChars - overlapChars) {
          const piece = para.slice(i, i + targetChars);
          chunks.push({ text: piece, source_pointer: section.source_pointer, metadata: section.metadata ?? {}, chunk_index: chunkIndex++ });
        }
        buffer = "";
      }
    }
    if (buffer.length > 0) {
      chunks.push({ text: buffer, source_pointer: section.source_pointer, metadata: section.metadata ?? {}, chunk_index: chunkIndex++ });
    }
  }
  return chunks;
}
