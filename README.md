# DeepConsol

**Smart SSH/Telnet terminal with embedded AI Co-pilot for Network Engineers.**

DeepConsol gives network engineers one browser screen with three linked panes:
a **terminal** (SSH/Telnet to routers, switches, core and RAN nodes), a **context
drawer** for collecting evidence, and an **AI chat** that answers from your own
knowledge base (MOPs, vendor guides, RCA archives). It's designed so engineers get
real AI help **without leaking secrets or customer data to a third-party model.**

Nothing moves between the terminal and the AI automatically. Terminal output
reaches the AI only when an engineer explicitly sends it through a sanitization
preview. Sanitization runs twice, first in the browser and again on the server.
Knowledge-base retrieval is isolated per team in SQL. SSH credentials are
encrypted with a key that never touches the database. AI-suggested commands
can't be copied to the clipboard until they pass a risk-classified review.
Sensitive actions are audited.

Runs **host-native** (systemd, no Docker) on a single Linux VM behind Nginx, and
installs with **one command** ([Quick start](#quick-start)).

---

## Table of contents

- [Why DeepConsol](#why-deepconsol)
- [Highlights](#highlights)
- [Quick start](#quick-start)
- [Installation guide (startup script)](#installation-guide-startup-script)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
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

## Why DeepConsol

Network engineers already use AI assistants, usually by pasting CLI output into a
public chatbot. That output is full of things that must not leave the operator's
network: device passwords and keys, SNMP communities, subscriber identifiers
(IMSI, MSISDN, IMEI), customer IPs and hostnames. The answers are also generic,
because the chatbot doesn't know your vendors, your network or your procedures.

DeepConsol puts the AI next to the terminal, and inside your controls.

### Benefits

| | Benefit | How |
|---|---|---|
| ⚡ | **Faster troubleshooting** | AI help in the same screen as the CLI. Select output, send it to chat, and get a structured answer (symptoms → hypotheses → commands → next steps → escalation). |
| 📚 | **Answers from *your* knowledge** | Upload MOPs, vendor guides and RCA archives. Answers cite the exact document section, and fall back to general knowledge only when they say so. |
| 🔒 | **Data stays protected** | Secrets are stripped, and subscriber and network identifiers are replaced with aliases (`IMSI_001`, `IP_001`), before anything reaches a model. Documents are sanitized before they are indexed. |
| 🧑‍✈️ | **Human always in control** | No auto-execution and no automatic terminal-to-AI path. Copying an AI-suggested command needs a confirmation step, and you must type `I UNDERSTAND` for risky ones (`commit`, `reload`, `write erase`…). |
| 👥 | **Team-scoped knowledge** | Documents can be global, per-group (Core, RAN, Transport, NOC…) or private. The scope is enforced in the database. |
| 🔁 | **No AI vendor lock-in** | Switch the chat provider between Gemini, OpenAI and Anthropic, or change the model, from the admin console. No restart is needed. |
| 🧭 | **Consistent diagnostics** | Built-in playbooks (LTE attach, VoLTE drop, 5G registration, packet loss, cell down, handover) give every engineer the same starting point. |
| 📝 | **Accountability** | Logins, terminal sessions, credential changes, document changes, AI queries and command copies are audit-logged, with redacted metadata only. |
| 🛠️ | **Simple to run** | One VM, no Docker or Kubernetes. A single script installs everything, checks for conflicts first, and health-checks the result. |

### Who it's for

- **NOC and operations engineers** handling alarms and first-line diagnostics.
- **Core / RAN / transport / IMS specialists** working on Cisco, Juniper, Nokia,
  Ericsson, Huawei, Mavenir and similar equipment.
- **Telecom operators and managed-service providers** that want AI assistance
  but can't send network data to a public chatbot.
- **Vendor support teams** who need a shared, cited knowledge base.

---

## Highlights

- **Web terminal gateway.** Interactive SSH (`ssh2` + PTY) and Telnet (an
  in-house client that handles Telnet protocol negotiation) bridged to xterm.js
  over a WebSocket. Includes per-user session caps, an idle timeout, window
  resize, and a startup sweep of orphaned sessions.
- **Human-gated AI.** Terminal text reaches the model only through an explicit
  *Send to chat → sanitization preview*. There's no raw selection, paste or drag
  path.
- **Two-pass security filtering.** Strips secrets and pseudonymizes telecom/PII
  identifiers on the **client before chat** and again on the **server**. 35
  built-in rules, each individually toggleable, plus admin-defined custom rules.
- **Group-isolated RAG.** Hybrid (vector + full-text + trigram) retrieval over
  `pgvector`, with `global`/`group`/`private` visibility enforced in SQL.
  Unauthorized chunks are never read, embedded into a prompt, or cited.
- **Context drawer.** Pin sanitized terminal output and free-form notes, then
  fold a chosen subset into your next chat message.
- **Pluggable AI providers.** Chat works with **Gemini, OpenAI or Anthropic**,
  switchable live from the admin UI. Embeddings stay on Gemini (fixed vector
  dimension) and are configured separately.
- **Built-in troubleshooting playbooks.** Structured RAN/core/transport
  diagnostic templates.
- **Encrypted SSH credential vault.** AES-256-GCM with the key held only in the
  environment, and a separate IV and authentication tag for every row.
- **Risk-gated copy.** AI command output is classified automatically
  (low/medium/high/critical); high and critical require typing `I UNDERSTAND`.
- **Full audit trail.** Auth, users/groups, credentials, terminal sessions,
  document lifecycle, RAG queries, chat and safe-copy, with redacted metadata
  only.
- **One-command install.** `ops/bootstrap.sh` checks for conflicts, installs
  everything, generates secrets, and health-checks the result.

---

## Quick start

On a fresh **Debian 12 / Ubuntu** VM, as a user with `sudo`:

```bash
git clone https://github.com/s-ttp/DeepConsol.git deepconsol
cd deepconsol

CHECK_ONLY=1 ./ops/bootstrap.sh                 # optional: dry-run the pre-flight checks
APP_PUBLIC_HOST=<public-ip-or-dns> ./ops/bootstrap.sh
```

Then open `https://<public-ip-or-dns>/` and accept the self-signed certificate.
Log in as `admin@deepconsol.local`; the password is `SEED_ADMIN_PASSWORD` in
`deepconsol/.env`. Add an AI provider key under **Admin → LLM Config**.

The full walkthrough, options, common scenarios and troubleshooting are in the
next section.

---

## Installation guide (startup script)

### 1. Requirements

| | Requirement |
|---|---|
| **OS** | Debian 12 (tested) or Ubuntu 22.04 / 24.04, with `apt` and `systemd` |
| **Size** | 2 vCPU / **4 GB RAM** (the web build is the peak), about **2 GB disk** for the app and dependencies, plus space for uploaded documents |
| **Access** | A normal user with `sudo`. The services run as this user, from wherever you clone the repo. |
| **Network in** | TCP **443** open to your users (open it in the cloud security group or firewall, too) |
| **Network out** | HTTPS to the Debian/Ubuntu mirrors, `deb.nodesource.com`, `apt.postgresql.org`, the npm registry, and your AI provider (`HTTPS_PROXY` is supported, see [Configuration](#configuration-env)) |
| **Free local ports** | 443 (or nginx already using it), 3002, 5001, 5002, and 6379 if the script installs Redis |
| **AI keys** *(optional)* | A key for Gemini, OpenAI or Anthropic for chat, and a Gemini key for embeddings. Everything else works without them; AI panels show "not configured". |

The script installs whatever is missing: **Node.js 20**, **PostgreSQL 15 +
pgvector + pg_trgm**, **Redis**, **Nginx** and **openssl**.

### 2. Get the code

```bash
git clone https://github.com/s-ttp/DeepConsol.git deepconsol
cd deepconsol
```

### 3. Dry run (recommended)

```bash
CHECK_ONLY=1 ./ops/bootstrap.sh
```

This runs only the **pre-flight checks** and changes nothing:

- **Ports:** 443/5001/5002/3002 must be free, or already used by nginx or
  DeepConsol itself. Port 6379 is also checked when Redis will be installed.
- **Node.js:** must be ≥ 20. If it's older, the script **warns that it will
  replace the system-wide Node**.
- **Host address:** warns if the auto-detected host is a **private IP** (common
  on cloud VMs).

If anything conflicts, the script stops with a message telling you what to
change (see [Common scenarios](#common-scenarios)).

### 4. Install

```bash
APP_PUBLIC_HOST=<public-ip-or-dns> ./ops/bootstrap.sh
```

`APP_PUBLIC_HOST` is the address users will type in the browser. Without it the
script uses the machine's first IP, which on a cloud VM is usually the
*internal* one. The address goes into the TLS certificate, the app URL and CORS.

The script runs these steps and **stops at the first failure**:

| Step | What happens |
|---|---|
| 0 · Pre-flight | Port, Node and Redis checks (as above), before anything is changed |
| 1 · Packages | Node 20 (NodeSource), PostgreSQL + **pgvector** (adds the official `apt.postgresql.org` repo when the distro lacks it, e.g. Debian 12), Nginx, Redis |
| 2 · Secrets | Configures a local Redis (**loopback only, generated password**), then writes `.env` (mode 600) with random JWT secret, vault key, DB password, Redis password and admin password. An existing `.env` is never overwritten. |
| 3 · Database | Creates the `deepconsol` role and database plus the `vector` / `pg_trgm` extensions. Any SQL error aborts. |
| 4 · Files | `/var/lib/deepconsol`, `/var/log/deepconsol`, and a 10-year self-signed certificate in `/etc/ssl/deepconsol/` |
| 5 · App | Runs `ops/install.sh`: `npm ci` → build → migrations + seed → systemd units + Nginx site → restart → **health check** |

The health check waits up to 60 s and verifies the API, the terminal gateway,
the web UI, both Nginx routes and all three services:

```text
==> Health check (waiting up to 60s for services to come up)
    OK   API            :5001
    OK   Terminal WS gw :5002
    OK   Web UI         :3002
    OK   nginx → web    :443
    OK   nginx → API    :443
    OK   deepconsol-api active
    OK   deepconsol-worker active
    OK   deepconsol-web active
```

If any check fails, the script exits non-zero and prints the recent service
logs. A typical first install takes about 5–10 minutes, mostly package
downloads and the web build.

### 5. Log in and finish setup

1. Browse to `https://<public-ip-or-dns>/` and accept the self-signed
   certificate warning.
2. Log in as `admin@deepconsol.local`. The password is **not printed**; read it
   with `grep SEED_ADMIN_PASSWORD .env`. You'll be taken to a screen to set your
   own password.
3. **Admin → LLM Config:** choose Gemini / OpenAI / Anthropic, paste the API
   key, click **Test connection**, and save.
4. **Admin → Embeddings:** add a Gemini key so documents are vector-indexed.
5. **Admin → Groups / Users:** create engineer accounts and assign teams.
6. **Admin → Documents:** upload your MOPs and vendor guides.

### Script options

Set these as environment variables before running (or prefix the command):

| Variable | Effect |
|---|---|
| `APP_PUBLIC_HOST` | Public IP or DNS name users connect to (default: first local IP) |
| `REDIS_URL` | Use an existing Redis instead of installing one, e.g. `redis://:password@127.0.0.1:6379/2`. Required when 6379 is already taken. |
| `SKIP_PKG=1` | Skip all `apt` installs (dependencies are already present) |
| `SKIP_NODE=1` | Never replace the system Node.js; abort if it's older than 20 |
| `CHECK_ONLY=1` | Run the pre-flight checks only and change nothing |

### Common scenarios

**Port 6379 is already used** (for example by another app's Redis in Docker).
The script refuses to install a second Redis on top of it. Either free the port,
or reuse that Redis on purpose with a database index no other app uses:

```bash
REDIS_URL=redis://[:password@]127.0.0.1:6379/2 ./ops/bootstrap.sh
```

**Cloud VM / NAT.** Always pass `APP_PUBLIC_HOST`. If `.env` was already created
with the wrong host, edit `APP_PUBLIC_HOST`, `APP_PUBLIC_URL` and
`CORS_ALLOWED_ORIGINS` in `.env`, delete `/etc/ssl/deepconsol/server.{crt,key}`
so the certificate is regenerated, and re-run the script.

**Other apps need the system Node.js.** If the host's Node is older than 20 and
other software depends on it, run with `SKIP_NODE=1`. The script will stop
instead of upgrading it, and you can install Node 20 another way (for example
with `nvm`).

**Nginx already serves other sites.** DeepConsol adds its own site
(`/etc/nginx/sites-available/deepconsol.conf`, `server_name _` on 443). If
another site also listens on 443 as the catch-all, set a real `server_name` in
`ops/nginx/deepconsol.conf` before installing.

**Real TLS certificate.** Once a domain points at the server, see
[Operations](#operations) for Let's Encrypt.

### What gets installed where

| Item | Location |
|---|---|
| Application and build output | The cloned directory |
| Secrets | `<clone>/.env` (mode 600, git-ignored) |
| Services | `deepconsol-api`, `deepconsol-worker`, `deepconsol-web` in `/etc/systemd/system/`, running as the installing user |
| Nginx site | `/etc/nginx/sites-available/deepconsol.conf` (symlinked into `sites-enabled`) |
| TLS certificate | `/etc/ssl/deepconsol/` |
| Uploaded documents / logs | `/var/lib/deepconsol/` / `/var/log/deepconsol/` |
| Database | PostgreSQL database and role `deepconsol` |
| Redis | Local `redis-server` on loopback with a password, unless you passed `REDIS_URL` |

### Updating

```bash
cd deepconsol
git pull
./ops/install.sh
```

`install.sh` rebuilds, applies new migrations, **restarts** the services so the
new build is actually loaded, and runs the same health check. It never touches
`.env`.

### Install troubleshooting

| Symptom | Fix |
|---|---|
| `Port N (...) is already in use by '<process>'` | Stop or move that process, or for 6379 use `REDIS_URL` (see above). Re-run. |
| `Could not install postgresql-15-pgvector` | Check outbound access to `apt.postgresql.org`, or install pgvector for your PostgreSQL version manually, then re-run. |
| `Node.js >= 20 is required ... SKIP_NODE` | Install Node 20+ yourself, or run without `SKIP_NODE` to let the script upgrade it. |
| `Redis ... did not answer PING` | `REDIS_URL` in `.env` is wrong or that Redis requires a password. Fix `.env` and re-run. |
| `Health check FAILED` | The script prints the last 40 log lines. For more: `sudo journalctl -u deepconsol-api -n 200`. |
| Browser can't connect | Open TCP 443 in the firewall / cloud security group, and check that `APP_PUBLIC_HOST` is an address users can reach. |
| Login says invalid credentials | Use the password from `.env`. The admin is created only **once**, so changing `SEED_ADMIN_PASSWORD` later has no effect. Reset it from another admin account. |

Re-running `./ops/bootstrap.sh` is always safe. It keeps the existing `.env`
and certificate and repeats only what's needed.

### Uninstall

```bash
sudo systemctl disable --now deepconsol-api deepconsol-worker deepconsol-web
sudo rm /etc/systemd/system/deepconsol-{api,worker,web}.service
sudo rm /etc/nginx/sites-enabled/deepconsol.conf /etc/nginx/sites-available/deepconsol.conf
sudo systemctl daemon-reload && sudo systemctl reload nginx
sudo -u postgres dropdb deepconsol && sudo -u postgres dropuser deepconsol
sudo rm -rf /var/lib/deepconsol /var/log/deepconsol /etc/ssl/deepconsol
```

This leaves the packages (Node, PostgreSQL, Redis, Nginx) installed. Delete the
cloned directory last; it contains `.env`.

---

## Architecture

```
                     Users (browser)
                          │ HTTPS 443
                          ▼
                ┌──────────────────┐
                │      Nginx       │   TLS termination (self-signed by default)
                │  (reverse proxy) │
                └──┬───────┬─────┬─┘
        /api/*     │       │ /   │  /terminal/connect/*  (WebSocket)
                   ▼       ▼     ▼
            127.0.0.1:5001  3002  5002
                API         Web   Terminal gateway ──SSH/Telnet──► network devices
                 │                 │
                 ├────────┬────────┘
                 ▼        ▼
       ┌──────────────┐ ┌──────────────┐
       │ PostgreSQL 15│ │ Redis (db 2) │◄── Worker (BullMQ): parse → sanitize →
       │ + pgvector   │ └──────────────┘    chunk → embed documents into pgvector
       │ + pg_trgm    │◄────────────────────────────┘
       └──────────────┘
                 │
                 └──► AI provider (Gemini / OpenAI / Anthropic) — sanitized text only
```

All app ports (`3002`, `5001`, `5002`) bind to `127.0.0.1`; only Nginx (`443`) is
exposed. The API process also hosts the terminal gateway on `5002`.

---

## Tech stack

| Layer | Tech |
|------|------|
| Frontend | Next.js 15 (App Router), React 19, Tailwind, xterm.js (fit/search/web-links/unicode/webgl) |
| Backend API | Fastify 5, TypeScript, Zod, JWT (HttpOnly cookies), bcrypt |
| Terminal gateway | Fastify WebSocket plugin, `ssh2` (SSH + PTY), in-house Telnet client |
| Worker | BullMQ on Redis; `pdf-parse` / `mammoth` / `jszip`+`xml2js` / `exceljs` / `csv-parse` / `cheerio` |
| RAG store | PostgreSQL 15 + `pgvector` (3072-dim) + `pg_trgm`; hybrid retrieval, group-isolated in SQL |
| AI (chat) | Gemini / OpenAI / Anthropic (provider-pluggable, admin-selectable) |
| AI (embeddings) | Gemini Embedding (`gemini-embedding-001`, 3072 dims) |
| TLS | Self-signed by default; swap for Let's Encrypt once a domain points at the host |
| Process management | systemd units (`deepconsol-api`, `deepconsol-worker`, `deepconsol-web`) |

---

## Repository layout

```
deepconsol/
├── package.json                 # npm workspaces root
├── .env.example                 # config template (bootstrap.sh generates .env from it)
├── apps/
│   ├── api/                     # Fastify HTTP API + WebSocket terminal gateway
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
    ├── bootstrap.sh             # first-time install on a fresh host (start here)
    ├── install.sh               # build + migrate + (re)start + health check; used for updates
    ├── publish.sh               # push to GitHub with a short-lived token
    ├── nginx/deepconsol.conf    # TLS reverse proxy site
    └── systemd/*.service        # api / worker / web units
```

### Developer scripts

| Script | Use it when |
|---|---|
| `ops/publish.sh` | Pushing to GitHub with a PAT from `GITHUB_TOKEN` (never written to `.git/config`): `GITHUB_TOKEN=… ./ops/publish.sh [remote-url] [branch]`. Revoke the token afterwards. |
| `npm run dev:api` / `dev:worker` / `dev:web` | Local development in watch mode (no systemd) |

Local development:

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

`ops/bootstrap.sh` generates `.env` from `.env.example` with random secrets. For a
manual setup, copy it and fill in real values, generating the two cryptographic
secrets with `openssl rand`. **`.env` is gitignored; never commit real secrets.**
After editing `.env`, restart the services (see [Operations](#operations)).

| Variable | Purpose |
|---|---|
| `APP_PUBLIC_HOST` / `APP_PUBLIC_URL` | Public host/URL for CORS and links |
| `API_PORT` (5001) · `TERMINAL_WS_PORT` (5002) | Internal ports (bind 127.0.0.1). The web UI port (3002) is set in `ops/systemd/deepconsol-web.service` and `ops/nginx/deepconsol.conf`; `WEB_PORT` is not read. |
| `DATABASE_URL` | Postgres connection string (contains the DB password) |
| `REDIS_URL` | Redis URL, e.g. `redis://:password@127.0.0.1:6379/2` (bootstrap generates the password) |
| `JWT_SECRET` | HS256 signing secret — `openssl rand -hex 32` |
| `JWT_TTL_HOURS` (12) | Session lifetime |
| `SSH_CRED_ENCRYPTION_KEY` | **KEK** for the AES-256-GCM vault — base64 32 bytes, `openssl rand -base64 32` |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Initial admin, created once on first install (marked must-change-password) |
| `GEMINI_API_KEY` | Default Gemini key (embeddings; chat fallback when no key saved) |
| `GEMINI_CHAT_MODEL` / `GEMINI_EMBEDDING_MODEL` | Default model names (overridable in the admin UI) |
| `GEMINI_WEB_GROUNDING_ENABLED` | Allow Google-Search grounding in "Web grounded" chat mode |
| `STORAGE_FS_ROOT` | Where uploaded documents are stored (filesystem). `STORAGE_DRIVER` is reserved; only `fs` exists today. |
| `UPLOAD_MAX_BYTES` · `INGEST_CHUNK_TARGET_TOKENS` (512) · `INGEST_CHUNK_OVERLAP_TOKENS` (64) | Upload + chunking |
| `TERMINAL_IDLE_TIMEOUT_SEC` (1800) · `TERMINAL_MAX_SESSIONS_PER_USER` (8) | Terminal limits (idle time counts keystrokes, not output) |
| `CHAT_HISTORY_RETENTION_DAYS` · `CHAT_MAX_CONCURRENT_PER_USER` · `TERMINAL_DEFAULT_SCROLLBACK` | **Reserved; not enforced yet** |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed browser origins |
| `LOG_LEVEL` | Pino log level |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` / `NODE_EXTRA_CA_CERTS` | Optional outbound proxy (and corporate CA bundle) for calls to the AI providers |

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

The web UI sends you to a change-password screen on first login (and for any
account an admin flags with *force password rotation*).

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

# Update to the latest code (rebuild, migrate, restart, health check)
cd /path/to/deepconsol && git pull && ./ops/install.sh

# Database shell
sudo -u postgres psql deepconsol
```

Back up the PostgreSQL database (`pg_dump deepconsol`), `/var/lib/deepconsol/docs`
and `.env` together. **Without `SSH_CRED_ENCRYPTION_KEY` from `.env`, saved SSH
credentials and AI keys in the database can't be decrypted.**

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

> This is an MVP. Before production, read [Known limitations](#known-limitations).
> In particular, restrict which hosts the terminal gateway can reach, and use a
> real TLS certificate. Track hardening work in the
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
- **Redis-persisted ingest jobs.** If Redis is wiped, queued jobs vanish and
  affected documents can be re-indexed from the UI.

Security hardening still to do (MVP):

- **Terminal targets aren't restricted.** Users can open sessions to any host
  and port the server can reach. Deploy the server in a network segment that can
  reach only the devices engineers should manage, and keep other services on the
  host (Redis, databases, cloud metadata) unreachable or password-protected. An
  admin-managed allow-list is planned.
- **No SSH host-key verification yet**, so a man-in-the-middle on the management
  network isn't detected.
- **Sessions can't be revoked early.** Logout clears the browser cookie, but a
  login token stays valid until `JWT_TTL_HOURS`. Role changes and deleted users
  take effect when the token expires.
- **Password-change-on-first-login is enforced by the web UI only**, not by the
  API.
- **No login rate limiting or lockout.**
- **Sanitizer coverage gaps.** These are not yet masked: Cisco `password 0`,
  `secret 8/9`, TACACS/RADIUS/ISAKMP keys, SNMPv3 `auth`/`priv` passphrases, and
  Juniper `$9$` secrets. Long plain numbers (e.g. interface counters, timestamps)
  can be over-masked as `MSISDN_nnn`. Add custom rules in **Admin → Filters** for
  anything specific to your network.
- **Bastion / jump-host fields** on saved credentials are stored but not yet used
  for connections.

---

## License

Released under the [MIT License](LICENSE). © 2026 s-ttp.
