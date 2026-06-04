-- DeepConsol initial schema.
-- Idempotent: safe to re-run during development; production migration runner
-- guards against double-application via schema_migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('engineer', 'admin')),
  must_rotate_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_group_memberships (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  role_in_group TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_ugm_group ON user_group_memberships(group_id);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'group', 'global')),
  vendor TEXT,
  domain TEXT,
  product TEXT,
  version TEXT,
  document_type TEXT,
  document_date DATE,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','queued','parsing','embedding','ready','error')),
  error_message TEXT,
  object_storage_key TEXT NOT NULL,
  byte_size BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);

CREATE TABLE IF NOT EXISTS document_acl (
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'read',
  PRIMARY KEY (document_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_acl_group ON document_acl(group_id);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  text TEXT NOT NULL,
  source_pointer TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(768),
  text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_tsv ON rag_chunks USING GIN(text_tsv);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_trgm ON rag_chunks USING GIN(text gin_trgm_ops);
-- HNSW index built lazily after embeddings exist; created_or_skipped at runtime.

CREATE TABLE IF NOT EXISTS chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','kb_only','model_only','web_grounded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS ssh_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INT NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('password','key')),
  -- AES-256-GCM envelope: iv || authTag || ciphertext, all base64.
  encrypted_secret TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  bastion_host TEXT,
  bastion_port INT,
  bastion_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ssh_creds_user ON ssh_credentials(user_id);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id UUID REFERENCES ssh_credentials(id) ON DELETE SET NULL,
  target TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_term_sessions_user ON terminal_sessions(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS playbooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  symptoms JSONB NOT NULL,
  questions JSONB NOT NULL,
  commands JSONB NOT NULL,
  expected_outputs JSONB NOT NULL,
  interpretation JSONB NOT NULL,
  next_steps JSONB NOT NULL,
  escalation_template TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
