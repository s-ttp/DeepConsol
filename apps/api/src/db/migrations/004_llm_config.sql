-- Singleton-row table holding the active chat LLM provider configuration.
-- The CHECK constraint on `id = 1` is the standard PostgreSQL trick for
-- "exactly one row" — INSERTs of any other id fail.
--
-- Embedding model intentionally NOT configurable here: the rag_chunks.embedding
-- column is fixed at vector(3072), which today only matches Gemini Embedding
-- 001. Switching providers for embeddings would require a vector dim change
-- and a full reindex of every document. Embeddings stay on Gemini (env-provided
-- GEMINI_API_KEY) regardless of which chat provider is selected.
--
-- API key envelope reuses the same KEK as ssh_credentials (SSH_CRED_ENCRYPTION_KEY).
CREATE TABLE IF NOT EXISTS llm_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'openai', 'anthropic')),
  chat_model TEXT NOT NULL,
  -- Optional override; null = use provider default base URL.
  api_base TEXT,
  -- AES-256-GCM envelope: empty string allowed when an admin saves "use env var".
  encrypted_api_key TEXT NOT NULL DEFAULT '',
  iv TEXT NOT NULL DEFAULT '',
  auth_tag TEXT NOT NULL DEFAULT '',
  -- True when the encrypted_api_key triplet above is populated; false means
  -- "fall back to GEMINI_API_KEY env var" (only valid for provider='gemini').
  has_api_key BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Seed with the existing Gemini defaults so chat keeps working post-migration
-- without admin intervention (the env-var GEMINI_API_KEY remains the source
-- until an admin saves a key through the UI).
INSERT INTO llm_config (id, provider, chat_model, has_api_key)
VALUES (1, 'gemini', 'gemini-3-pro-preview', FALSE)
ON CONFLICT (id) DO NOTHING;
