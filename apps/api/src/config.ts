import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid number for ${name}: ${v}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export const config = {
  env: optional("APP_ENV", "production"),
  publicHost: required("APP_PUBLIC_HOST"),
  publicUrl: required("APP_PUBLIC_URL"),

  apiHost: optional("API_HOST", "127.0.0.1"),
  apiPort: num("API_PORT", 5001),
  terminalWsHost: optional("TERMINAL_WS_HOST", "127.0.0.1"),
  terminalWsPort: num("TERMINAL_WS_PORT", 5002),

  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),

  jwtSecret: required("JWT_SECRET"),
  jwtTtlHours: num("JWT_TTL_HOURS", 12),
  sessionCookieName: optional("SESSION_COOKIE_NAME", "deepconsol_session"),

  sshCredEncryptionKey: required("SSH_CRED_ENCRYPTION_KEY"),

  seedAdminEmail: optional("SEED_ADMIN_EMAIL", "admin@deepconsol.local"),
  seedAdminPassword: optional("SEED_ADMIN_PASSWORD", ""),

  geminiApiKey: optional("GEMINI_API_KEY", ""),
  geminiChatModel: optional("GEMINI_CHAT_MODEL", "gemini-3-pro"),
  geminiEmbeddingModel: optional("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001"),
  geminiApiBase: optional("GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta"),
  geminiWebGroundingEnabled: bool("GEMINI_WEB_GROUNDING_ENABLED", true),

  storageDriver: optional("STORAGE_DRIVER", "fs"),
  storageFsRoot: optional("STORAGE_FS_ROOT", "/var/lib/deepconsol/docs"),

  uploadMaxBytes: num("UPLOAD_MAX_BYTES", 100 * 1024 * 1024),
  ingestChunkTargetTokens: num("INGEST_CHUNK_TARGET_TOKENS", 512),
  ingestChunkOverlapTokens: num("INGEST_CHUNK_OVERLAP_TOKENS", 64),

  terminalIdleTimeoutSec: num("TERMINAL_IDLE_TIMEOUT_SEC", 1800),
  terminalMaxSessionsPerUser: num("TERMINAL_MAX_SESSIONS_PER_USER", 8),
  terminalDefaultScrollback: num("TERMINAL_DEFAULT_SCROLLBACK", 10000),

  chatHistoryRetentionDays: num("CHAT_HISTORY_RETENTION_DAYS", 90),
  chatMaxConcurrentPerUser: num("CHAT_MAX_CONCURRENT_PER_USER", 4),

  corsAllowedOrigins: optional("CORS_ALLOWED_ORIGINS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  logLevel: optional("LOG_LEVEL", "info"),
};

export function geminiConfigured(): boolean {
  return Boolean(
    config.geminiApiKey &&
      config.geminiApiKey.length > 0 &&
      !config.geminiApiKey.startsWith("REPLACE_ME")
  );
}
