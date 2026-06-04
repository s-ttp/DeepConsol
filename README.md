# DeepConsol

**Secure web SSH/Telnet terminal + AI copilot for telecom network engineers.**

DeepConsol puts three panes on one screen — a server-gated **terminal**
(xterm.js over an SSH/Telnet gateway), a client-side **context drawer** for
staging snippets, and an **AI chat** grounded in your own knowledge base. It is
deliberately *not* auto-integrated: terminal output never reaches the AI unless
a human explicitly sends it through a sanitization preview, and AI-suggested
commands can't be copied to the OS clipboard until they pass a risk-classified
review modal.

The whole product is built around one idea: **engineers get AI help without
leaking secrets or customer data to a third-party model.** Sanitization runs
twice (client then server), retrieval is group-isolated in SQL, SSH credentials
are encrypted with a KEK that never touches the database, and every sensitive
action is audited.

Runs **host-native** (systemd, no Docker) on a single Linux VM behind Nginx.

---

## Table of contents

- [Highlights](#highlights)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Configuration](#configuration-env)
- [First login](#first-login)
- [Admin console](#admin-console)
  - [AI providers (LLM config)](#ai-providers--llm-config)
  - [Embeddings](#embeddings)
  - [Sanitization filters](#sanitization-filters)
  - [Knowledge base & group isolation](#knowledge-base--group-isolation)
- [Terminal safety model](#terminal-safety-model)
- [SSH credential vault](#ssh-credential-vault)
- [Database & migrations](#database--migrations)
- [Audit events](#audit-events)
- [Operations](#operations)
- [Security model](#security-model-summary)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Highlights

- **Web terminal gateway** — interactive SSH (via `ssh2`) and Telnet (in-house
  IAC-aware client) bridged to xterm.js over a WebSocket. Per-user session caps,
  idle timeout, and startup sweep of orphaned sessions.
- **Human-gated AI** — terminal text reaches the model only through an explicit
  *Send to chat → sanitization preview* step. No raw selection, paste, or
  drag-drop path exists.
- **Two-pass sanitizer** — strips secrets and pseudonymizes telecom/PII
  identifiers **on the client before chat and again on the server**. 35 built-in
  rules, admin-toggleable, plus admin-defined custom rules. See
  [Sanitization filters](#sanitization-filters).
- **Group-isolated RAG** — hybrid (vector + full-text + trigram) retrieval over
  `pgvector`, with visibility enforced in SQL (`global` / `group` / `private`)
  so unauthorized chunks are never read, embedded into a prompt, or cited.
- **Pluggable AI providers** — chat works with **Gemini, OpenAI, or Anthropic**,
  configured live from the admin UI (no restart). Embeddings stay on Gemini
  (fixed vector dimension) and are independently configurable.
- **Encrypted SSH credential vault** — AES-256-GCM with a KEK held only in the
  environment; each row gets a fresh IV and auth tag.
- **Risk-gated copy** — AI command output is auto-classified
  (low/medium/high/critical); high & critical require typing `I UNDERSTAND`
  before the clipboard write.
- **Full audit trail** — auth, user/group changes, credential lifecycle,
  terminal sessions, document lifecycle, RAG queries, chat messages, and
  safe-copy confirmations — with redacted metadata only.

---

## Architecture

```
                       Internet
                          │ TCP 443
                          ▼
                ┌──────────────────┐
                │      Nginx       │   TLS termination (self-signed by default)
                │  (reverse proxy) │
                └──┬───────┬─────┬─┘
        /api/*     │       │ /   │  /terminal/connect/*  (WS upgrade)
       (HTTP proxy)│       │     │
                   ▼       ▼     ▼
            127.0.0.1:5001  3002  5002
                API         Web   Terminal-WS
                 │           │     │
                 └─────┬─────┘     │
                       ▼           │
            ┌──────────────────┐   │
            │ Postgres 15 +    │   │
            │  pgvector / trgm │   │
            ├──────────────────┤   │
            │ Redis 7 (db 2)   │◄──┘
            └──────────────────┘
                       ▲
            Worker (BullMQ) ── pulls ingest jobs from Redis, reads docs
                               from disk, parses + chunks + embeds, writes
                               to pgvector
```

All app ports (`3002`, `5001`, `5002`) bind to `127.0.0.1` only. Only Nginx
(`443`) is publicly reachable. The API process also hosts the terminal WS
gateway on a second port.

---

## Tech stack

| Layer | Tech |
|------|------|
| Frontend | Next.js 15 (App Router), React 19, Tailwind, xterm.js (fit/search/web-links/unicode/webgl addons) |
| Backend API | Fastify 5, TypeScript, Zod, JWT (HttpOnly cookies), bcrypt |
| Terminal gateway | Fastify WebSocket plugin, `ssh2` (SSH + PTY), in-house Telnet client |
| Worker | BullMQ on Redis; `pdf-parse` / `mammoth` / `jszip`+`xml2js` / `exceljs` / `csv-parse` / `cheerio` |
| RAG store | Postgres 15 + `pgvector` (3072-dim) + `pg_trgm`, hybrid retrieval, group-isolated in SQL |
| AI — chat | Gemini / OpenAI / Anthropic (provider-pluggable, admin-selectable) |
| AI — embeddings | Gemini Embedding (`gemini-embedding-001`, 3072 dims) |
| TLS | Self-signed by default; swap for Let's Encrypt once a domain points at the host |
| Process mgmt | systemd units (`deepconsol-api`, `deepconsol-worker`, `deepconsol-web`) |

---

## Repository layout

```
deepconsol/
├── package.json                 # npm workspaces root
├── .env.example                 # config template (copy → .env, fill in secrets)
├── apps/
│   ├── api/                     # Fastify HTTP API + WS terminal gateway
│   │   └── src/
│   │       ├── routes/          # auth, users, groups, ssh-credentials, terminal,
│   │       │                    # chat, knowledge, llm-config, embedding-config,
│   │       │                    # sanitizer-config, safe-copy, playbooks
│   │       ├── services/        # crypto, gemini, llm, embedding, retrieval,
│   │       │                    # sanitizer-config, queue, storage, audit
│   │       ├── ws/              # terminal-gateway, telnet
│   │       ├── auth/            # jwt, middleware, password
│   │       └── db/              # pool, migrate, seed, migrations/*.sql
│   ├── worker/                  # BullMQ ingestion worker (parsers + chunker + embedder)
│   └── web/                     # Next.js frontend (workspace + admin console)
├── packages/
│   └── shared/                  # browser-safe: types, sanitizer, risk classifier, playbooks
└── ops/
    ├── install.sh               # one-shot install / update
    ├── nginx/deepconsol.conf
    └── systemd/*.service
```

---

## Getting started

### Prerequisites

- Linux host, **Node.js ≥ 20**
- **PostgreSQL 15** with `pgvector` and `pg_trgm` extensions
- **Redis 7**
- **Nginx** (for the TLS reverse proxy)
- An API key for at least one chat provider (Gemini / OpenAI / Anthropic) and a
  Gemini key for embeddings — AI features degrade gracefully with a clear
  "not configured" message until a key is set.

### Install / deploy (host-native)

```bash
git clone https://github.com/s-ttp/DeepConsole.git deepconsol
cd deepconsol
cp .env.example .env          # then fill in real secrets (see Configuration)
./ops/install.sh
```

`install.sh` runs `npm ci` → builds all four workspaces → runs DB migrations and
seed → installs the Nginx site and three systemd units → enables and starts
everything.

### Local development

```bash
npm install
cp .env.example .env          # point DATABASE_URL / REDIS_URL at local services
npm run build                 # build shared → api → worker → web
npm run migrate               # apply DB migrations (also runs automatically on API boot)
npm run seed                  # create the seed admin user

# Run each service in watch mode (separate terminals):
npm run dev:api               # API + terminal WS gateway
npm run dev:worker            # ingestion worker
npm run dev:web               # Next.js dev server
```

Build a single workspace with `npm run build:shared | build:api | build:worker |
build:web`.

---

## Configuration (`.env`)

Copy `.env.example` to `.env` and fill in real values. **`.env` is gitignored —
never commit real secrets.** Generate the two cryptographic secrets with
`openssl rand`.

| Variable | Purpose |
|---|---|
| `APP_PUBLIC_HOST` / `APP_PUBLIC_URL` | Public host/URL used for CORS and links |
| `API_PORT` (5001) · `TERMINAL_WS_PORT` (5002) · `WEB_PORT` (3002) | Internal service ports (bind 127.0.0.1) |
| `DATABASE_URL` | Postgres connection string (contains the DB password) |
| `REDIS_URL` | Redis URL (uses db index 2 by default) |
| `JWT_SECRET` | HS256 signing secret — `openssl rand -hex 32` |
| `JWT_TTL_HOURS` (12) | Session lifetime |
| `SSH_CRED_ENCRYPTION_KEY` | **KEK** for the AES-256-GCM credential vault — base64 32 bytes, `openssl rand -base64 32` |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Bootstrap admin (forced rotation on first login) |
| `GEMINI_API_KEY` | Default Gemini key (embeddings; chat fallback when no key saved in the DB) |
| `GEMINI_CHAT_MODEL` / `GEMINI_EMBEDDING_MODEL` | Default model names (overridable per the admin UI) |
| `GEMINI_WEB_GROUNDING_ENABLED` | Allow Google-Search grounding in "Web grounded" chat mode |
| `STORAGE_DRIVER` / `STORAGE_FS_ROOT` | Object storage (filesystem by default; `Storage` interface is S3/MinIO-swappable) |
| `UPLOAD_MAX_BYTES` · `INGEST_CHUNK_TARGET_TOKENS` · `INGEST_CHUNK_OVERLAP_TOKENS` | Upload + chunking limits |
| `TERMINAL_IDLE_TIMEOUT_SEC` · `TERMINAL_MAX_SESSIONS_PER_USER` · `TERMINAL_DEFAULT_SCROLLBACK` | Terminal session limits |
| `CHAT_HISTORY_RETENTION_DAYS` · `CHAT_MAX_CONCURRENT_PER_USER` | Chat limits |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed browser origins |
| `LOG_LEVEL` | Pino log level |

> The chat model, provider, API keys, embedding model, and sanitizer rules are
> **runtime settings managed from the admin console** and stored in the database;
> the env vars above are bootstrap defaults / fallbacks.

---

## First login

```text
URL:      https://<your-server>/        (accept the self-signed cert warning)
Email:    admin@deepconsol.local        (SEED_ADMIN_EMAIL)
Password: see SEED_ADMIN_PASSWORD in your .env
```

You are forced to rotate the password on first login.

---

## Admin console

The admin area (`/admin`, admin role only) has these tabs:

| Tab | What it manages |
|---|---|
| **Documents** | Upload, (re)index, set visibility, and delete knowledge-base documents |
| **Groups** | Create groups and manage membership (drives RAG visibility) |
| **Users** | Create users, set roles, force password rotation |
| **LLM Config** | Chat provider, model, API key, base URL — applied live |
| **Embeddings** | Embedding model, API key, base URL — with a dimension-validating test |
| **Filters** | Toggle built-in sanitizer rules and add custom redaction/alias rules |

### AI providers (LLM config)

Chat is provider-pluggable. Pick **Gemini**, **OpenAI**, or **Anthropic** in
**Admin → LLM Config**, set the model and API key (encrypted at rest with the
same KEK as the credential vault), and save — changes apply immediately with no
restart. A **Test connection** button verifies auth/model/network before you
rely on it.

| Provider | Default model | Default base URL |
|---|---|---|
| Gemini | `gemini-3-pro-preview` | `https://generativelanguage.googleapis.com/v1beta` |
| OpenAI | `gpt-5.4` | `https://api.openai.com/v1` |
| Anthropic | `claude-sonnet-4-6` | `https://api.anthropic.com/v1` |

You can override the model with any your account has access to. If no key is
saved for Gemini, chat falls back to the `GEMINI_API_KEY` env var. When a model
is retired by the provider, switch to a current one here — chat resolves the
model from this setting.

### Embeddings

**Admin → Embeddings** manages the model that vectorizes KB documents and chat
queries for retrieval. The provider is **locked to Gemini** because the
`rag_chunks.embedding` column is fixed at **3072 dimensions** — a model with a
different output size cannot be stored without a column change and full reindex.
The **Test embedding** button checks the returned dimension and warns before you
save a mismatched model. The embedding API key is encrypted at rest, with an
env-var fallback. After changing the model, **Reindex** existing documents to
refresh their vectors.

### Sanitization filters

**Admin → Filters** controls the sanitizer that masks data before it reaches the
AI. There are **35 built-in baseline rules** (24 redaction, 11 pseudonymization),
each individually toggleable but **pattern-locked** (you can disable a rule but
not rewrite its regex, so a typo can't silently weaken protection). On top of the
baseline you can add **custom rules** using a guided builder — a literal string
or simple wildcard (`*` / `?`), set to **Redact** (remove) or **Pseudonymize**
(alias). No raw regex, so there's no risk of a catastrophic pattern.

Built-in coverage includes:

- **Secrets (removed):** SSH/PGP/PuTTY private keys, SSH public keys, JWTs,
  Bearer/Basic/Authorization headers, cookies, AWS/Google API keys,
  GitHub/Slack/Stripe/SendGrid/Google-OAuth tokens, `api_key`/`token`/`password`
  key-value pairs, Cisco `password 7` / `secret 5` / `enable secret`, Unix/bcrypt
  password hashes, connection strings with embedded credentials, SNMP communities,
  **SIM auth keys (Ki / OPc)**, emails, E.164 phone numbers, credit cards.
- **Identifiers (pseudonymized to stable aliases, e.g. `IMSI_001`):** IMSI, IMEI,
  MSISDN, ICCID, SUPI/SUCI/GUTI/TMSI, PLMN/TAC/LAC/RAC/eNB/gNB/APN, cell IDs,
  public IPv4/IPv6, MAC addresses, hostnames. Private/loopback IP ranges are
  deliberately **preserved** so internal topology stays readable.

A **Test filters** box lets you preview exactly what the current ruleset masks.
Changes propagate to open chat sessions on tab focus and to the server/worker
within ~30s. Disabling a rule is audit-logged. If the rule config can't be
loaded for any reason, the **full hardcoded baseline runs** — sanitization is
never silently dropped.

### Knowledge base & group isolation

Documents are uploaded (PDF/DOCX/PPTX/XLSX/CSV/HTML/TXT), parsed, sanitized,
chunked, and embedded by the worker. Retrieval is **hybrid** (vector similarity +
`ts_rank` full-text + trigram) and ranked.

```text
Visibility = global  → all users
           = group   → users in any of the assigned groups
           = private → owner only
```

Filtering is enforced at the **SQL layer** in `retrieve()`
([apps/api/src/services/retrieval.ts](apps/api/src/services/retrieval.ts)), not
in the frontend — so chunks a user can't see are never read, embedded into a
prompt, or surfaced as citations.

---

## Terminal safety model

- Terminal output **never** reaches chat without explicit user action.
- Right-click on selected terminal text → **Send to Chat (sanitized)** /
  **Pin to Drawer** / **Copy Sanitized** / **Copy Raw**.
- Sanitization runs **twice** — client-side before text enters the chat
  composer, and server-side again before retrieval, prompt construction, AI
  calls, and chat-history storage.
- AI command output can't be copied with the OS clipboard until it passes the
  **Review & Copy** modal. Risk is auto-classified (low/medium/high/critical);
  high & critical require typing `I UNDERSTAND`. See
  [packages/shared/src/risk.ts](packages/shared/src/risk.ts).

---

## SSH credential vault

Credentials are **AES-256-GCM**-encrypted in Postgres. The KEK lives only in the
`SSH_CRED_ENCRYPTION_KEY` env var (base64 32 bytes), so DB-only access can't
reveal them. Each row gets a fresh IV and auth tag. Credentials are scoped to
their owner and never returned to the client.

> Rotating the KEK requires re-encrypting every row; there is no rotation tool in
> the MVP, so plan it with a maintenance window.

---

## Database & migrations

Migrations live in
[apps/api/src/db/migrations/](apps/api/src/db/migrations/) and run automatically
on API startup (and via `npm run migrate`). They are tracked in
`schema_migrations` and applied idempotently.

| Migration | Purpose |
|---|---|
| `001_init` | Core schema (users, groups, documents, rag_chunks, chat, audit, ssh_credentials, terminal_sessions) |
| `002_embedding_dim_3072` | Set the `rag_chunks.embedding` vector dimension to 3072 |
| `003_telnet_support` | Telnet connection support |
| `004_llm_config` | Singleton chat-provider config (provider/model/key) |
| `005_embedding_config` | Singleton embedding config (model/key, Gemini-locked) |
| `006_sanitizer_rules` | Sanitizer overlay: built-in toggles + custom rules |

---

## Audit events

Logged to `audit_events` with **redacted metadata only** (no raw command output,
no decrypted secrets, content stored as hashes where relevant):

`auth.login` · `auth.login_failed` · `auth.logout` · `auth.password_rotated` ·
`user.created` · `user.updated` · `group.*` · `ssh_credential.created` ·
`ssh_credential.deleted` · `terminal.session_started` · `terminal.session_ended` ·
`knowledge.document_uploaded` · `knowledge.document_indexed` ·
`knowledge.document_visibility_changed` · `knowledge.document_deleted` ·
`rag.query` · `chat.message_sent` · `chat.message_received` ·
`safe_copy.confirmed` · `llm_config.*` · `embedding_config.*` ·
`sanitizer_config.*`

---

## Operations

```bash
# Status / logs
sudo systemctl status deepconsol-api deepconsol-worker deepconsol-web
sudo journalctl -u deepconsol-api -f
sudo journalctl -u deepconsol-worker -f

# Restart after a .env change
sudo systemctl restart deepconsol-api deepconsol-worker deepconsol-web

# Re-run migrations after pulling code
cd /path/to/deepconsol && npm run build && node apps/api/dist/db/migrate.js
sudo systemctl restart deepconsol-api deepconsol-worker deepconsol-web
```

To enable TLS with a real cert once a domain points at the host:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain
# then update ssl_certificate* paths in ops/nginx/deepconsol.conf
```

---

## Security model summary

- **Defense-in-depth sanitization** — client + server, fail-safe to the full
  baseline, admin-tunable.
- **Group-isolated retrieval** — enforced in SQL, not the UI; parameterized
  queries throughout.
- **Encrypted credential & API-key vault** — AES-256-GCM, env-resident KEK,
  per-row IV + auth tag; secrets never returned to clients.
- **Human-in-the-loop AI** — explicit send-to-chat, risk-gated copy.
- **Auditing** — sensitive actions recorded with redacted metadata.
- **Network posture** — app ports bound to loopback; only Nginx is public; JWT in
  HttpOnly/Secure/SameSite cookies.

> This is an MVP. Recommended hardening before production: enable login
> rate-limiting, add SSH host-key verification / an allow-list for terminal
> targets, and front the app with a real TLS certificate. See the
> [issues](https://github.com/s-ttp/DeepConsole/issues) tracker.

---

## Known limitations

- **Self-signed cert by default** — browsers warn on first visit until you swap
  in Let's Encrypt.
- **Email/password auth only** — no SSO; SAML/OIDC is a future enhancement.
- **No KEK rotation tool** — plan a maintenance window.
- **Filesystem object storage** by default — the `Storage` interface is abstract
  so S3/MinIO is a drop-in replacement.
- **Embeddings are Gemini-only** — the vector column is fixed at 3072 dims;
  changing providers requires a column change + full reindex.
- **Redis-persisted ingest jobs** (db 2) — if Redis is wiped, queued jobs vanish
  and affected documents move to `error` status (re-indexable from the admin UI).

---

## License

No license file is included yet. Until one is added, all rights are reserved by
the repository owner — open an issue to discuss usage.
