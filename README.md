# DeepConsol

**Secure web SSH/Telnet terminal + AI copilot for telecom network engineers.**

DeepConsol gives engineers a single screen with three coordinated panes — a
server-gated **terminal**, a **context drawer** for staging evidence, and an **AI
chat** grounded in your own knowledge base — designed so they get real AI help
**without leaking secrets or customer data to a third-party model.**

It is deliberately *not* auto-integrated. Terminal output never reaches the AI
unless a human explicitly sends it through a sanitization preview. Sanitization
runs twice (client then server). Retrieval is group-isolated in SQL. SSH
credentials are encrypted with a key that never touches the database. AI command
suggestions can't be copied to the OS clipboard until they pass a risk-classified
review. Every sensitive action is audited.

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
- [The workspace](#the-workspace)
- [Knowledge base & RAG](#knowledge-base--rag)
- [Security filtering (the sanitizer)](#security-filtering-the-sanitizer)
- [Context drawer](#context-drawer)
- [Terminal & safety model](#terminal--safety-model)
- [Troubleshooting playbooks](#troubleshooting-playbooks)
- [SSH credential vault](#ssh-credential-vault)
- [Admin console](#admin-console)
- [Database & migrations](#database--migrations)
- [Audit events](#audit-events)
- [Operations](#operations)
- [Security model summary](#security-model-summary)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Highlights

- **Web terminal gateway** — interactive SSH (`ssh2` + PTY) and Telnet (in-house
  IAC-aware client) bridged to xterm.js over a WebSocket; per-user session caps,
  idle timeout, NAWS window resize, and startup sweep of orphaned sessions.
- **Human-gated AI** — terminal text reaches the model only through an explicit
  *Send to chat → sanitization preview*. No raw selection, paste, or drag path.
- **Two-pass security filtering** — strips secrets and pseudonymizes telecom/PII
  identifiers on the **client before chat** and again on the **server**; 35
  built-in rules, individually toggleable, plus admin-defined custom rules.
- **Group-isolated RAG** — hybrid (vector + full-text + trigram) retrieval over
  `pgvector`, with `global`/`group`/`private` visibility enforced in SQL so
  unauthorized chunks are never read, embedded into a prompt, or cited.
- **Context drawer** — pin sanitized terminal output and free-form notes, then
  fold a chosen subset into your next chat message.
- **Pluggable AI providers** — chat works with **Gemini, OpenAI, or Anthropic**,
  switchable live from the admin UI; embeddings stay on Gemini (fixed vector
  dimension) and are independently configurable.
- **Built-in troubleshooting playbooks** — structured RAN/core/transport
  diagnostic templates (LTE attach, VoLTE drop, 5G registration, packet loss,
  cell down, handover failure).
- **Encrypted SSH credential vault** — AES-256-GCM, KEK held only in the env;
  per-row IV + auth tag.
- **Risk-gated copy** — AI command output auto-classified
  (low/medium/high/critical); high & critical require typing `I UNDERSTAND`.
- **Full audit trail** — auth, users/groups, credentials, terminal sessions,
  document lifecycle, RAG queries, chat, and safe-copy — redacted metadata only.

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

All app ports (`3002`, `5001`, `5002`) bind to `127.0.0.1` only; only Nginx
(`443`) is public. The API process also hosts the terminal WS gateway on `5002`.

---

## Tech stack

| Layer | Tech |
|------|------|
| Frontend | Next.js 15 (App Router), React 19, Tailwind, xterm.js (fit/search/web-links/unicode/webgl) |
| Backend API | Fastify 5, TypeScript, Zod, JWT (HttpOnly cookies), bcrypt |
| Terminal gateway | Fastify WebSocket plugin, `ssh2` (SSH + PTY), in-house Telnet client |
| Worker | BullMQ on Redis; `pdf-parse` / `mammoth` / `jszip`+`xml2js` / `exceljs` / `csv-parse` / `cheerio` |
| RAG store | Postgres 15 + `pgvector` (3072-dim) + `pg_trgm`; hybrid retrieval, group-isolated in SQL |
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
- **PostgreSQL 15** with `pgvector` and `pg_trgm`
- **Redis 7**
- **Nginx** (TLS reverse proxy)
- An API key for at least one chat provider (Gemini / OpenAI / Anthropic) and a
  Gemini key for embeddings. AI features degrade gracefully with a clear
  "not configured" message until a key is set.

### One-command install (fresh host)

On a clean Debian/Ubuntu VM, `ops/bootstrap.sh` does the whole first-time setup:

```bash
git clone https://github.com/s-ttp/DeepConsol.git deepconsol
cd deepconsol
./ops/bootstrap.sh
```

It will:

1. Install prerequisites (Node 20, PostgreSQL + pgvector, Redis, Nginx) if missing.
2. Generate `.env` with **strong random secrets** (JWT secret, vault KEK, DB
   password, seed admin password) — only if `.env` doesn't already exist.
3. Create the Postgres role + database + `vector`/`pg_trgm` extensions.
4. Create runtime dirs and a self-signed TLS cert.
5. Build, migrate, seed, install the systemd units + Nginx site, and start
   everything.

It's **idempotent** — safe to re-run. Override the public host or skip package
install with `APP_PUBLIC_HOST=1.2.3.4 ./ops/bootstrap.sh` or
`SKIP_PKG=1 ./ops/bootstrap.sh`. The generated seed-admin password is printed at
the end and stored in `.env`.

### Rebuild / redeploy (already set up)

When prerequisites and `.env` already exist (e.g. after `git pull`), use the
lighter installer:

```bash
cp .env.example .env          # first time only — then fill in real secrets
./ops/install.sh
```

`install.sh` runs `npm ci` → builds all four workspaces → runs DB migrations and
seed → renders & installs the Nginx site and three systemd units (portable to any
checkout path / user) → enables and starts everything.

### Publishing to GitHub

`ops/publish.sh` pushes the repo using a token supplied via the environment — the
token is injected into the push URL only for the command and is **never written
to `.git/config` or committed**:

```bash
GITHUB_TOKEN=ghp_xxx ./ops/publish.sh
# or target a specific remote/branch:
GITHUB_TOKEN=ghp_xxx ./ops/publish.sh https://github.com/<owner>/<repo>.git main
```

> Treat the PAT as disposable — revoke it once you're done.

### Local development

```bash
npm install
cp .env.example .env          # point DATABASE_URL / REDIS_URL at local services
npm run build                 # shared → api → worker → web
npm run migrate               # apply migrations (also runs on API boot)
npm run seed                  # create the seed admin

npm run dev:api               # API + terminal WS gateway (watch)
npm run dev:worker            # ingestion worker (watch)
npm run dev:web               # Next.js dev server (watch)
```

Build one workspace with `npm run build:shared | build:api | build:worker | build:web`.

---

## Configuration (`.env`)

Copy `.env.example` to `.env` and fill in real values. **`.env` is gitignored —
never commit real secrets.** Generate the two cryptographic secrets with
`openssl rand`.

| Variable | Purpose |
|---|---|
| `APP_PUBLIC_HOST` / `APP_PUBLIC_URL` | Public host/URL for CORS and links |
| `API_PORT` (5001) · `TERMINAL_WS_PORT` (5002) · `WEB_PORT` (3002) | Internal ports (bind 127.0.0.1) |
| `DATABASE_URL` | Postgres connection string (contains the DB password) |
| `REDIS_URL` | Redis URL (uses db index 2 by default) |
| `JWT_SECRET` | HS256 signing secret — `openssl rand -hex 32` |
| `JWT_TTL_HOURS` (12) | Session lifetime |
| `SSH_CRED_ENCRYPTION_KEY` | **KEK** for the AES-256-GCM vault — base64 32 bytes, `openssl rand -base64 32` |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Bootstrap admin (forced rotation on first login) |
| `GEMINI_API_KEY` | Default Gemini key (embeddings; chat fallback when no key saved) |
| `GEMINI_CHAT_MODEL` / `GEMINI_EMBEDDING_MODEL` | Default model names (overridable in the admin UI) |
| `GEMINI_WEB_GROUNDING_ENABLED` | Allow Google-Search grounding in "Web grounded" chat mode |
| `STORAGE_DRIVER` / `STORAGE_FS_ROOT` | Object storage (filesystem default; `Storage` interface is S3/MinIO-swappable) |
| `UPLOAD_MAX_BYTES` · `INGEST_CHUNK_TARGET_TOKENS` (512) · `INGEST_CHUNK_OVERLAP_TOKENS` (64) | Upload + chunking |
| `TERMINAL_IDLE_TIMEOUT_SEC` (1800) · `TERMINAL_MAX_SESSIONS_PER_USER` (8) · `TERMINAL_DEFAULT_SCROLLBACK` | Terminal limits |
| `CHAT_HISTORY_RETENTION_DAYS` · `CHAT_MAX_CONCURRENT_PER_USER` | Chat limits |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed browser origins |
| `LOG_LEVEL` | Pino log level |

> The chat provider/model/keys, embedding model, and sanitizer rules are
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

## The workspace

The engineer's main screen (`/workspace`) is a resizable three-pane layout:

```
┌───────────────────────────────┬───────────────┐
│  Terminal (xterm.js)          │   Chat        │
│  — SSH / Telnet tabs          │   — KB-grounded
│  — right-click selection →    │     answers   │
│      Send to Chat / Pin /     │   — provenance
│      Copy Sanitized / Raw     │     badges    │
│                               │   — Review &  │
│                               │     Copy modal│
├───────────────────────────────┤               │
│  Context Drawer (popup)       │               │
│  — pinned snippets + notes    │               │
└───────────────────────────────┴───────────────┘
```

**End-to-end flow.** You SSH into a node and run diagnostics. You select
interesting output, right-click, and either **Send to Chat** (opens a
sanitization preview you can edit before it enters the composer) or **Pin to
Context Drawer** (stages it, sanitized, for later). In chat you pick a **mode**
(see below), optionally fold in pinned snippets, and ask. The answer comes back
tagged with its **provenance** (KB / general model / web) and **citations**. If
the model suggests commands, copying them to your clipboard goes through the
**Review & Copy** risk modal. At no point does un-previewed terminal output or an
un-reviewed command move between the human and the model automatically.

The chat panel width is draggable and persisted; snippets persist across drawer
toggles and tab refreshes within a session.

---

## Knowledge base & RAG

DeepConsol answers from **your** documents (MOPs, vendor guides, RCA archives,
config standards) using retrieval-augmented generation, with isolation enforced
in the database.

### Ingestion pipeline

Upload happens in **Admin → Documents**; the API stores the file and enqueues a
BullMQ job. The worker
([apps/worker/src/worker.ts](apps/worker/src/worker.ts)) then:

1. **Parse** (`status: parsing`) — format-specific extractors produce *sections*
   (a page, slide, or sheet range), each with a `source_pointer` used later for
   citations:
   | Format | Parser |
   |---|---|
   | PDF | `pdf-parse` |
   | DOCX | `mammoth` → HTML → heading split |
   | PPTX | `jszip` + `xml2js` (slides + speaker notes) |
   | XLSX | `exceljs` (per-sheet, per-row) |
   | CSV | `csv-parse` |
   | HTML | `cheerio` (scripts/styles stripped) |
   | TXT | plain |
2. **Sanitize** — every section is run through the sanitizer (same engine and
   admin overlay as chat), so **secrets and PII never enter the vector store** and
   can't be recalled by a later query.
3. **Chunk** (`source: chunker.ts`) — token-aware (~4 chars/token), default
   **512-token target with 64-token overlap**. Sections are hard breaks (no
   bleed across pages/slides/sheets); within a section it splits on paragraphs,
   carries an overlap tail between chunks, and hard-splits any oversized
   paragraph.
4. **Embed** (`status: embedding`) — each chunk is embedded via the configured
   Gemini embedding model (3072-dim). If embeddings aren't configured, chunks are
   stored **text-only** so keyword search still works and a later **Reindex**
   backfills vectors.
5. **Store** (`status: ready`) — chunks land in `rag_chunks`; an audit event
   records counts. Failures set `status: error` with a message (re-indexable from
   the UI).

Document **metadata** — `vendor`, `domain`, `product`, `version`,
`document_type`, `document_date` — is captured on upload and usable as retrieval
filters.

### Hybrid retrieval

`retrieve()` ([apps/api/src/services/retrieval.ts](apps/api/src/services/retrieval.ts))
runs a single SQL query that:

- Builds an **`allowed` CTE** restricting to documents the user may see:
  `global ∪ owner=user ∪ document_acl.group_id ∈ user_groups`, plus any
  vendor/domain/product/version filters.
- Scores each chunk with a **hybrid** signal:
  ```
  combined = 0.6 · vector_score + 0.4 · max(ts_rank, trigram_similarity)
  vector_score = 1 − (embedding <=> query_embedding)      # cosine
  ```
- Returns the **top 8** chunks, including a chunk if it has an embedding *or* a
  positive full-text rank *or* trigram similarity > 0.1.
- Flags **high confidence** when the top chunk's combined score ≥ **0.55**.

Isolation is in the SQL `WHERE`/CTE — never the frontend — so a user can't even
cause a forbidden chunk to be read, embedded into a prompt, or cited.

```text
Visibility = global  → all users
           = group   → users in any of the assigned groups
           = private → owner only
```

### Chat modes & provenance

Each message runs in one of four modes (per-thread default, overridable):

| Mode | Behavior |
|---|---|
| **Auto** | Retrieve; use KB context only when retrieval is high-confidence, otherwise answer from general model knowledge. |
| **KB only** | Always use KB; if nothing relevant is found, say so rather than guess. |
| **Model only** | No retrieval; pure model knowledge. |
| **Web grounded** | Gemini Google-Search grounding; citations are web URIs. |

Answers carry a **provenance** badge — `KB`, `GEN` (general), `WEB`, or `mixed` —
and KB answers cite chunks as `doc_id#source_pointer`. The system prompt steers
the model toward a consistent diagnostic structure (Symptoms → Hypotheses →
Evidence to gather → Suggested commands → Interpretation → Next steps →
Escalation), keeps it vendor-aware (Cisco, Juniper, Nokia, Ericsson, Huawei,
Mavenir), forbids it from "executing" anything, and tells it to refer to
pseudonymized identifiers by their aliases (`IMSI_001`, `IP_001`, …) rather than
echoing raw values.

---

## Security filtering (the sanitizer)

The sanitizer ([packages/shared/src/sanitizer.ts](packages/shared/src/sanitizer.ts))
is the core of the no-leak design. It runs in **both** the browser and Node, and
is applied at **two independent points**:

```
   terminal / KB doc / user input
            │
   ┌────────▼─────────┐   client pass (before text enters the chat composer
   │  sanitize()      │   or the context drawer)
   └────────┬─────────┘
            │  (server must NEVER trust the client)
   ┌────────▼─────────┐   server pass (before retrieval, prompt construction,
   │  sanitize()      │   the AI call, web grounding, and history storage; and
   └────────┬─────────┘   on every document chunk at ingestion)
            ▼
        AI provider
```

It does two kinds of masking:

- **Redaction** — the value is destroyed and replaced with a tag like
  `[REDACTED:PRIVATE_KEY]`.
- **Pseudonymization** — the value is replaced with a **stable alias**
  (`IMSI_001`, `IP_001`, `HOST_001`, …). Aliasing is deterministic *within a
  message*, so the model can still reason about "the same IMSI appears twice"
  without ever seeing the real value. **Private/loopback IP ranges are
  deliberately preserved** so internal topology stays readable.

### Built-in rules (35 baseline)

**Redaction (24):** SSH / PGP / PuTTY private keys, SSH public keys, JWTs,
Authorization / Bearer / Basic headers, cookies, AWS & Google API keys,
GitHub / Slack / Stripe / SendGrid / Google-OAuth tokens,
`api_key`/`token`/`password` key-value pairs, Cisco `password 7` / `secret 5` /
`enable secret`, Unix & bcrypt password hashes, **connection strings with
embedded credentials**, SNMP communities, **SIM auth keys (Ki / OPc)**, emails,
E.164 phone numbers, credit cards.

**Pseudonymization (11):** IMSI, IMEI, MSISDN, **ICCID**, **SUPI / SUCI / GUTI /
TMSI**, **PLMN / TAC / LAC / RAC / eNB / gNB / APN**, cell IDs, public IPv4 / IPv6,
MAC addresses, hostnames.

### Admin-editable overlay

In **Admin → Filters**, the built-in rules are a **locked safe baseline** — each
can be toggled **on/off** but its pattern can't be rewritten, so a typo can never
silently weaken core protection. On top of the baseline, admins add **custom
rules** with a guided builder:

- A **literal** string or a **wildcard** pattern (`*` = any run of non-space
  chars, `?` = one char) — **no raw regex**, so there is no ReDoS risk.
- An action of **Redact** or **Pseudonymize** (with a chosen alias prefix).

A **Test filters** box previews exactly what the current ruleset masks. Changes
propagate to open chat sessions on tab focus and to the server/worker within
~30s, and are audit-logged. If the overlay can't be loaded for any reason, the
**full hardcoded baseline runs** — sanitization is never silently dropped.

> The two passes are intentional and complementary: the client pass gives instant
> in-browser feedback and the editable preview; the server pass is authoritative
> and re-applies the same rules to everything that touches the model — including
> KB chunks at ingestion — because the server must never trust the client.

---

## Context drawer

The context drawer ([apps/web/src/components/ContextDrawer.tsx](apps/web/src/components/ContextDrawer.tsx))
is a client-side staging area between the terminal and the chat — a place to
collect evidence before asking.

- **Pin** terminal output via right-click → *Pin to Context Drawer* (the drawer
  pops open). Every pinned snippet is **sanitized on entry** — secrets stripped,
  identifiers pseudonymized — before it ever appears in the list.
- **Notes** — type free-form notes (alarm summaries, hypotheses, RCA hints)
  directly into the drawer.
- Each snippet has a **source** (`terminal` / `chat` / `note`), can be
  **starred** (pins sort to the top), and removed.
- **Fold into chat** — tick the snippets you want and *Insert selected into
  chat*, or insert all. They're appended to your next message draft.
- Snippets live at the workspace level (so pins fire even while the drawer is
  closed) and persist across drawer toggles and tab refreshes within a session.

This keeps the human firmly in the loop: nothing in the drawer reaches the model
until you explicitly insert it and send.

---

## Terminal & safety model

- **Connectivity** — interactive **SSH** (`ssh2` with a real PTY) and **Telnet**
  (an in-house IAC-aware client with chunk-safe parsing and NAWS window resize),
  bridged to **xterm.js** with fit / search / web-links / unicode11 / webgl
  addons. Connect ad-hoc or from a saved vault credential; multiple tabs.
- **Limits** — per-user session cap (`TERMINAL_MAX_SESSIONS_PER_USER`), idle
  timeout, configurable scrollback. Orphaned session rows are swept on API
  startup so the cap can't be exhausted by crashes.
- **Right-click menu** on a selection: **Send to Chat (sanitized)** ·
  **Pin to Drawer** · **Copy Sanitized** · **Copy Raw**.
- **No automatic path** from terminal to AI — only the explicit, previewed
  actions above.
- **Review & Copy** — copying AI-suggested command output to the OS clipboard is
  gated by a modal that auto-classifies risk via
  [packages/shared/src/risk.ts](packages/shared/src/risk.ts):

  | Level | Examples | Gate |
  |---|---|---|
  | critical | `write erase`, `mkfs`, `dd if=`, `rm -rf /`, `reload in`, `drop database` | type `I UNDERSTAND` |
  | high | `commit`, `no shutdown`, `clear counters`, `reboot`, `sudo`, `iptables -F` | type `I UNDERSTAND` |
  | medium | `debug`, `tcpdump`, `snmpset` | confirm |
  | low | `show`, `display`, `ping`, `cat`, `grep` | confirm |

  A pasted block is graded by its **worst** line; the server re-classifies and
  records a hash of the content (never the raw text) on confirmation.

---

## Troubleshooting playbooks

DeepConsol ships structured diagnostic playbooks
([packages/shared/src/playbooks.ts](packages/shared/src/playbooks.ts)) covering
common RAN / core / transport faults:

- **LTE Attach Failure** (Mobility / EPS)
- **VoLTE Call Drop** (Voice / IMS)
- **5G Registration Reject** (5GC)
- **High Packet Loss** (Transport)
- **Cell Down** (RAN)
- **Handover Failure** (RAN)

Each playbook is a consistent template — *symptoms → clarifying questions →
suggested commands → expected outputs → interpretation → next steps → escalation
template* — giving engineers a structured starting point and the AI a shared
vocabulary for diagnostics.

---

## SSH credential vault

Credentials are **AES-256-GCM**-encrypted in Postgres
([apps/api/src/services/crypto.ts](apps/api/src/services/crypto.ts)). The KEK
lives only in `SSH_CRED_ENCRYPTION_KEY` (base64 32 bytes), so DB-only access
can't reveal them. Each row gets a fresh IV and auth tag. Credentials are scoped
to their owner and **never returned to the client**.

> Rotating the KEK requires re-encrypting every row; there is no rotation tool in
> the MVP, so plan it with a maintenance window.

---

## Admin console

The admin area (`/admin`, admin role only):

| Tab | Manages |
|---|---|
| **Documents** | Upload, (re)index, set visibility/metadata, delete KB documents |
| **Groups** | Create groups and manage membership (drives RAG visibility) |
| **Users** | Create users, set roles, force password rotation |
| **LLM Config** | Chat provider, model, API key, base URL — applied live |
| **Embeddings** | Embedding model, API key, base URL — with a dimension-validating test |
| **Filters** | Toggle built-in sanitizer rules and add custom redaction/alias rules |

### AI providers (LLM config)

Pick **Gemini**, **OpenAI**, or **Anthropic**, set the model and API key
(encrypted at rest with the vault KEK), and save — changes apply immediately, no
restart. A **Test connection** button verifies auth/model/network first.

| Provider | Default model | Default base URL |
|---|---|---|
| Gemini | `gemini-3-pro-preview` | `https://generativelanguage.googleapis.com/v1beta` |
| OpenAI | `gpt-5.4` | `https://api.openai.com/v1` |
| Anthropic | `claude-sonnet-4-6` | `https://api.anthropic.com/v1` |

Override the model with any your account can access. If no Gemini key is saved,
chat falls back to `GEMINI_API_KEY`. When a provider retires a model, switch to a
current one here — chat resolves the model from this setting.

### Embeddings

**Admin → Embeddings** manages the model that vectorizes KB documents and chat
queries. The provider is **locked to Gemini** because the `rag_chunks.embedding`
column is fixed at **3072 dimensions** — a model with a different output size
can't be stored without a column change and full reindex. The **Test embedding**
button checks the returned dimension and warns before you save a mismatched
model. The embedding key is encrypted at rest with an env-var fallback. After
changing the model, **Reindex** existing documents.

---

## Database & migrations

Migrations live in
[apps/api/src/db/migrations/](apps/api/src/db/migrations/) and run automatically
on API startup (and via `npm run migrate`), tracked idempotently in
`schema_migrations`.

| Migration | Purpose |
|---|---|
| `001_init` | Core schema (users, groups, documents, rag_chunks, chat, audit, ssh_credentials, terminal_sessions) |
| `002_embedding_dim_3072` | Set `rag_chunks.embedding` to 3072 dims |
| `003_telnet_support` | Telnet connection support |
| `004_llm_config` | Singleton chat-provider config |
| `005_embedding_config` | Singleton embedding config (Gemini-locked) |
| `006_sanitizer_rules` | Sanitizer overlay: built-in toggles + custom rules |

---

## Audit events

Logged to `audit_events` with **redacted metadata only** (no raw command output,
no decrypted secrets; content as hashes where relevant):

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

Enable a real TLS cert once a domain points at the host:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain
# then update ssl_certificate* paths in ops/nginx/deepconsol.conf
```

---

## Security model summary

- **Defense-in-depth sanitization** — client + server passes, applied to user
  input *and* KB chunks, fail-safe to the full baseline, admin-tunable.
- **Group-isolated retrieval** — enforced in SQL via the `allowed` CTE, not the
  UI; parameterized queries throughout.
- **Encrypted credential & API-key vault** — AES-256-GCM, env-resident KEK,
  per-row IV + auth tag; secrets never returned to clients.
- **Human-in-the-loop AI** — explicit send-to-chat preview, staged context
  drawer, risk-gated copy.
- **Auditing** — sensitive actions recorded with redacted metadata.
- **Network posture** — app ports bound to loopback; only Nginx is public; JWT in
  HttpOnly / Secure / SameSite cookies.

> This is an MVP. Recommended hardening before production: enable login
> rate-limiting, add SSH host-key verification and/or an allow-list for terminal
> targets, and front the app with a real TLS certificate. Track these in the
> [issues](https://github.com/s-ttp/DeepConsol/issues) tab.

---

## Known limitations

- **Self-signed cert by default** — browsers warn until you swap in Let's Encrypt.
- **Email/password auth only** — no SSO; SAML/OIDC is a future enhancement.
- **No KEK rotation tool** — plan a maintenance window.
- **Filesystem object storage** by default — the `Storage` interface is abstract
  so S3/MinIO is a drop-in replacement.
- **Embeddings are Gemini-only** — the vector column is fixed at 3072 dims;
  changing providers needs a column change + full reindex.
- **Redis-persisted ingest jobs** (db 2) — if Redis is wiped, queued jobs vanish
  and affected documents move to `error` status (re-indexable from the UI).

---

## License

Released under the [MIT License](LICENSE). © 2026 s-ttp.
