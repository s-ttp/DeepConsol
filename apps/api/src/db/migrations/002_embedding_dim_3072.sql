-- Switch rag_chunks.embedding from vector(768) to vector(3072) so we can use
-- the native gemini-embedding-001 dimensionality without truncation.
--
-- Safe only if no embeddings exist with the old dim (they would fail the
-- dimension check during ALTER). The migration runner is one-way; if you
-- need to roll back, set embedding = NULL on every row, ALTER back to 768,
-- and re-embed.

ALTER TABLE rag_chunks
  ALTER COLUMN embedding TYPE vector(3072);
