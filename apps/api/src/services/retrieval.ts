import { query } from "../db/pool.js";
import { embed } from "./gemini.js";

export interface RetrievedChunk {
  id: string;
  document_id: string;
  filename: string;
  visibility: string;
  text: string;
  source_pointer: string | null;
  vector_score: number;
  text_score: number;
  combined_score: number;
}

export interface RetrievalFilters {
  vendor?: string;
  domain?: string;
  product?: string;
  version?: string;
}

const VECTOR_WEIGHT = 0.6;
const TEXT_WEIGHT = 0.4;
const TOP_K = 8;
const HIGH_CONFIDENCE_THRESHOLD = 0.55;

/**
 * Hybrid retrieval enforcing group-isolation in SQL.
 *
 * Allowed = global ∪ owner=user ∪ document_acl.group_id ∈ user_groups
 *
 * Query path: vector similarity (when embeddings available) + ts_rank text
 * search; combined and ranked. Filters apply to document metadata.
 */
export async function retrieve(
  user_id: string,
  group_ids: string[],
  q: string,
  filters: RetrievalFilters = {}
): Promise<{ chunks: RetrievedChunk[]; high_confidence: boolean }> {
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embed(q);
  } catch {
    queryEmbedding = null;
  }

  const filterClauses: string[] = [];
  const params: unknown[] = [user_id, group_ids];
  let p = params.length;

  if (filters.vendor) { params.push(filters.vendor); filterClauses.push(`d.vendor = $${++p}`); }
  if (filters.domain) { params.push(filters.domain); filterClauses.push(`d.domain = $${++p}`); }
  if (filters.product) { params.push(filters.product); filterClauses.push(`d.product = $${++p}`); }
  if (filters.version) { params.push(filters.version); filterClauses.push(`d.version = $${++p}`); }

  let embeddingExpr = "0.0";
  if (queryEmbedding) {
    params.push(`[${queryEmbedding.join(",")}]`);
    embeddingExpr = `(1.0 - (c.embedding <=> $${++p}::vector))`;
  }
  params.push(q);
  const tsExpr = `COALESCE(ts_rank(c.text_tsv, plainto_tsquery('english', $${++p})), 0)`;
  params.push(q);
  const trgmExpr = `COALESCE(similarity(c.text, $${++p}), 0)`;
  params.push(TOP_K);
  const limitParam = `$${++p}`;

  const sql = `
    WITH allowed AS (
      SELECT d.id, d.filename, d.visibility
      FROM documents d
      WHERE d.status = 'ready'
        AND (
          d.visibility = 'global'
          OR d.owner_user_id = $1
          OR EXISTS (
            SELECT 1 FROM document_acl a
            WHERE a.document_id = d.id AND a.group_id = ANY($2::uuid[])
          )
        )
        ${filterClauses.length ? "AND " + filterClauses.join(" AND ") : ""}
    )
    SELECT
      c.id,
      c.document_id,
      a.filename,
      a.visibility,
      c.text,
      c.source_pointer,
      ${embeddingExpr} AS vector_score,
      ${tsExpr}       AS text_score,
      (
        ${embeddingExpr} * ${VECTOR_WEIGHT}
        + GREATEST(${tsExpr}, ${trgmExpr}) * ${TEXT_WEIGHT}
      ) AS combined_score
    FROM rag_chunks c
    JOIN allowed a ON a.id = c.document_id
    WHERE c.embedding IS NOT NULL OR ${tsExpr} > 0 OR ${trgmExpr} > 0.1
    ORDER BY combined_score DESC
    LIMIT ${limitParam}
  `;

  const { rows } = await query<RetrievedChunk>(sql, params);
  const top = rows[0];
  const high_confidence = !!top && top.combined_score >= HIGH_CONFIDENCE_THRESHOLD;
  return { chunks: rows, high_confidence };
}
