-- Admin-editable overlay for the sanitizer (packages/shared/src/sanitizer.ts).
--
-- The built-in rules remain a HARDCODED SAFE BASELINE in code. These tables
-- only store the *overlay* an admin layers on top:
--   * sanitizer_builtin_overrides — which built-in rules are turned off. A rule
--     with no row is enabled (default-on); an explicit row with enabled=FALSE
--     disables it. Patterns are NOT stored here — built-ins are toggle-only, so
--     a typo can never weaken the core regexes.
--   * sanitizer_custom_rules — admin-defined "guided" rules (literal/wildcard,
--     never raw regex), each redacting or pseudonymizing matches.
--
-- If both tables are empty (or unreadable), the sanitizer runs the full
-- baseline — sanitization can never be silently dropped.

CREATE TABLE IF NOT EXISTS sanitizer_builtin_overrides (
  rule_name TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sanitizer_custom_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type IN ('literal', 'wildcard')),
  value TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('redact', 'pseudonymize')),
  alias_prefix TEXT,
  case_insensitive BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sanitizer_custom_rules_enabled
  ON sanitizer_custom_rules (enabled);
