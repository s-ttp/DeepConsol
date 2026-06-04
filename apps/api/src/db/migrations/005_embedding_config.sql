-- Singleton-row table holding the active EMBEDDING model configuration.
-- Companion to llm_config (004), which governs the *chat* provider. Embeddings
-- are kept separate because they are deliberately constrained:
--
--   * provider is locked to 'gemini' — the rag_chunks.embedding column is fixed
--     at vector(3072) (migration 002), which today only matches Gemini Embedding
--     models. Switching to a model with a different output dimension would
--     require a column change + full reindex, so the admin UI exposes the model
--     name (and its API key/base) but NOT the provider.
--   * `dimension` records the expected output size so the Test action can flag a
--     model whose vectors won't fit the column before an admin saves it.
--
-- API key envelope reuses the same KEK as ssh_credentials / llm_config
-- (SSH_CRED_ENCRYPTION_KEY). has_api_key = FALSE means "fall back to the
-- GEMINI_API_KEY env var", preserving pre-migration behaviour.
CREATE TABLE IF NOT EXISTS embedding_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'gemini' CHECK (provider IN ('gemini')),
  embedding_model TEXT NOT NULL,
  -- Optional override; null/'' = use the provider default base URL.
  api_base TEXT,
  -- AES-256-GCM envelope; empty triplet allowed when falling back to env var.
  encrypted_api_key TEXT NOT NULL DEFAULT '',
  iv TEXT NOT NULL DEFAULT '',
  auth_tag TEXT NOT NULL DEFAULT '',
  has_api_key BOOLEAN NOT NULL DEFAULT FALSE,
  -- Expected embedding dimension; must match the rag_chunks.embedding column.
  dimension INT NOT NULL DEFAULT 3072,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Seed with the existing env-provided default so ingestion keeps working
-- post-migration without admin intervention (env GEMINI_API_KEY remains the
-- key source until an admin saves one through the new Embeddings tab).
INSERT INTO embedding_config (id, provider, embedding_model, has_api_key)
VALUES (1, 'gemini', 'gemini-embedding-001', FALSE)
ON CONFLICT (id) DO NOTHING;
