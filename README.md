# DeepConsol

[![CI](https://github.com/s-ttp/DeepConsol/actions/workflows/ci.yml/badge.svg)](https://github.com/s-ttp/DeepConsol/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

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
- [Security & privacy features](#security--privacy-features)
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
- [Contributing & security reports](#contributing--security-reports)
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
  identifiers (IMSI, MSISDN, IMEI, ICCID, SUPI/GUTI, PLMN/TAC/APN, cell IDs, IPs,
  hostnames) on the **client before chat** and again on the **server**. 35
  built-in rules, each individually toggleable, plus admin-defined custom rules
  (e.g. alias your national MSISDN format or customer names). See
  [Security & privacy features](#security--privacy-features).
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
7. **Restrict terminal targets:** set `TERMINAL_ALLOWED_CIDRS` in `.env` to your
   device management networks, then
   `sudo systemctl restart deepconsol-api` (see
   [Terminal target policy](#terminal-target-policy)).

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

Run the test suites (sanitizer: one case per built-in rule plus alias, overlay
and IPv6/MAC regressions; API: terminal target policy) with:

```bash
npm test
```

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
| `TERMINAL_ALLOWED_CIDRS` · `TERMINAL_DENIED_CIDRS` | Terminal target policy: comma-separated CIDRs or IPs (see [Terminal target policy](#terminal-target-policy)). An invalid entry stops the API from starting. |
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
│      Copy Sanitized           │     badges    │
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

## Security & privacy features

DeepConsol's security controls at a glance. Each one is explained in more detail below.

| Area | Control | Who can change it |
|---|---|---|
| **Data sent to AI** | Two-pass sanitizer: secrets **redacted**, subscriber and network identifiers **pseudonymized** (IMSI, MSISDN, IMEI, ICCID, SUPI/GUTI, PLMN/TAC/APN, cell IDs, IPs, MACs, hostnames…) | Admin: toggle each rule, add custom rules |
| | Editable sanitization **preview** before terminal text enters chat | Engineer (per message) |
| | Knowledge-base documents sanitized **before indexing** | Same filter settings as chat |
| | No automatic terminal → AI path | Fixed by design |
| **AI output** | Command **risk classification** (low / medium / high / critical) with typed `I UNDERSTAND` for high and critical | Fixed rules |
| | AI can't execute anything; it only suggests | Fixed by design |
| **Access** | Roles: `engineer` / `admin`. Admin console is admin-only. | Admin (Users) |
| | Knowledge-base visibility: `global` / `group` / `private`, enforced in SQL | Admin (Documents, Groups) |
| | SSH credentials, terminal sessions and chat threads visible only to their owner | Fixed |
| **Secrets at rest** | SSH credentials and AI provider keys encrypted with AES-256-GCM; key only in `.env` | Install-time key |
| | User passwords hashed with bcrypt (cost 12) | Fixed |
| **Sessions** | JWT in an HttpOnly, Secure, SameSite=Lax cookie; 12 h lifetime | `JWT_TTL_HOURS` |
| | Password change required on first login and on admin request | Admin (Users) |
| **Terminal** | **Target policy:** the server itself, loopback and cloud metadata are always blocked; optional allow-list / deny-list | `TERMINAL_ALLOWED_CIDRS`, `TERMINAL_DENIED_CIDRS` |
| | Per-user session cap, idle timeout, orphaned-session cleanup | `TERMINAL_MAX_SESSIONS_PER_USER`, `TERMINAL_IDLE_TIMEOUT_SEC` |
| **Network** | App ports on loopback only; Nginx TLS with HSTS, `X-Frame-Options: DENY`, `nosniff`, strict referrer and permissions policy | `ops/nginx/deepconsol.conf` |
| | Local Redis bound to loopback with a password (bootstrap) | `REDIS_URL` |
| **Host** | systemd hardening: `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome=read-only`, `PrivateTmp`, restricted write paths | `ops/systemd/*.service` |
| **Accountability** | Audit log of sensitive actions with redacted metadata (content stored as hashes) | — |

### The sanitizer

The sanitizer ([packages/shared/src/sanitizer.ts](packages/shared/src/sanitizer.ts))
is one engine that runs in both the browser and the server, so the preview you
see is what the server enforces.

**Where it runs:**

| Point | Side | What happens |
|---|---|---|
| Terminal → **Send to Chat** | Browser | Shows a preview with redaction/pseudonymization counts; you can edit the text before it goes into the composer |
| Terminal → **Pin to Drawer** | Browser | Snippets are sanitized before they appear in the drawer |
| Terminal → **Copy Sanitized** | Browser | Copies the sanitized text to the clipboard (e.g. for tickets or email) |
| **Every chat message** (typed text and attached snippets) | Server | Re-sanitized before retrieval, the AI call, web grounding and storage. **The server never trusts the browser's pass.** |
| **Document ingestion** | Worker | Every page, slide or sheet is sanitized before chunking and embedding, so secrets never enter the knowledge base |

**Two kinds of masking:**

- **Redact:** the value is destroyed and replaced by a tag, e.g. `[REDACTED:PRIVATE_KEY]`.
- **Pseudonymize:** the value is replaced by an **alias** such as `IMSI_001`,
  so the AI can still reason about it ("the same IMSI appears in both
  traces") without seeing the real value.

### Built-in rules (35)

The examples below are actual sanitizer output.

**Secrets: redacted (24 rules)**

| Rule (name in Admin → Filters) | Masks | Example |
|---|---|---|
| `ssh-private-key-block` | OpenSSH / PEM private keys | `-----BEGIN OPENSSH PRIVATE KEY----- …` → `[REDACTED:PRIVATE_KEY]` |
| `pgp-private-key-block` | PGP private key blocks | → `[REDACTED:PRIVATE_KEY]` |
| `putty-private-key` | PuTTY `.ppk` keys | → `[REDACTED:PRIVATE_KEY]` |
| `openssh-pubkey-with-comment` | `ssh-rsa` / `ssh-ed25519` / `ecdsa` public keys (+ comment) | `ssh-ed25519 AAAAC3… noc@jump01` → `[REDACTED:SSH_KEY]` |
| `authorization-header` | HTTP `Authorization:` headers | → `Authorization: [REDACTED]` |
| `cookie-header` | `Cookie` / `Set-Cookie` values | → `Cookie: [REDACTED]` |
| `bearer-token` | Bearer tokens | `Bearer abcdef1234567890xyz` → `Bearer [REDACTED]` |
| `basic-auth` | Basic-auth credentials | → `Basic [REDACTED]` |
| `jwt` | JSON Web Tokens | `eyJhbGci….eyJzdWIi….c2ln…` → `[REDACTED:JWT]` |
| `connection-string-creds` | `user:pass@` inside URIs | `mongodb://admin:S3cret@db…` → `mongodb://[REDACTED]@HOST_001:27017` |
| `aws-access-key` | AWS key IDs (`AKIA…`/`ASIA…`) | → `[REDACTED:AWS_ACCESS_KEY]` |
| `google-api-key` | Google API keys (`AIza…`) | → `[REDACTED:API_KEY]` |
| `cloud-provider-token` | GitHub, Slack, Stripe, SendGrid, Google OAuth tokens | → `[REDACTED:TOKEN]` |
| `generic-api-key-kv` | `api_key=…`, `x-api-key: …` | `api_key=9f8e7d6c5b4a3f2e1d0c` → `api_key: [REDACTED]` |
| `generic-token-kv` | `token=…`, `access_token=…`, `secret=…` | → `token: [REDACTED]` |
| `password-kv` | `password: …`, `passwd=…`, `pwd=…`, `enable_secret=…` | `password: Winter2026!` → `password: [REDACTED]` |
| `cisco-type7-password` | Cisco `password 7` / `secret 5` | `password 7 0822455D0A16` → `password 7 [REDACTED]` |
| `cisco-enable-secret` | Cisco `enable secret …` | → `enable secret [REDACTED]` |
| `unix-password-hash` | Shadow / bcrypt hashes (`$1$`, `$5$`, `$6$`, `$2y$`) | `root:$6$…:19000` → `root:[REDACTED:HASH]:19000` |
| `sim-auth-key` | SIM keys **Ki / OP / OPc** (32 hex) | `Ki=465B5CE8…` → `Ki: [REDACTED]` |
| `snmp-community` | `snmp-server community …` | `snmp-server community Publ1cR0 RO` → `snmp-server community [REDACTED] RO` |
| `credit-card` | Card numbers with separators | `4111-1111-1111-1111` → `[REDACTED:CARD]` |
| `email` | Email addresses | `noc.lead@operator.com` → `[REDACTED:EMAIL]` |
| `phone-e164` | Phone numbers with a leading `+` | `+966501234567` → `[REDACTED:PHONE]` |

**Subscriber and network identifiers: pseudonymized (11 rules)**

| Rule | Masks | Example |
|---|---|---|
| `iccid` | SIM serial numbers (`89…`, 18–20 digits) | `iccid: 8996601234567890123` → `iccid: ICCID_001` |
| `imei` | Device IMEI (when labelled `IMEI`) | `IMEI: 356938035643809` → `IMEI: IMEI_001` |
| `imsi` | Subscriber IMSI (any 14–15-digit number) | `IMSI 420011234567890` → `IMSI IMSI_001` |
| `msisdn` | Subscriber MSISDN (any 10–15-digit number) | `msisdn=966501234567` → `msisdn=MSISDN_001` |
| `subscriber-id` | SUPI / SUCI / 5G-GUTI / GUTI / P-TMSI / M-TMSI / TMSI (when labelled) | `5G-GUTI: 42001-0a1b-…` → `5G-GUTI: SUBID_001` |
| `network-id` | PLMN / TAC / LAC / RAC / eNB / gNB / APN (when labelled) | `PLMN: 42001 TAC: 0x1A2B APN=internet.operator` → `PLMN: NETID_001 TAC: NETID_002 APN=NETID_003` |
| `cellid` | Cell IDs: `cell-id` / CGI / ECI / NCI (when labelled) | `cell-id: 1A2B3C` → `cell-id: CELL_001` |
| `ipv4` | **Public** IPv4 addresses (private ranges kept, see below) | `peer 203.0.113.7 via 10.20.0.1` → `peer IP_001 via 10.20.0.1` |
| `ipv6` | **Public** IPv6 addresses, full or `::`-compressed (loopback, link-local `fe80::/10` and unique-local `fc00::/7` kept) | `neighbor 2001:db8:85a3::8a2e:370:7334` → `neighbor IP6_001` |
| `mac` | MAC addresses: `00:1a:2b:3c:4d:5e`, `00-1a-2b-3c-4d-5e`, Cisco `001a.2b3c.4d5e` | `001a.2b3c.4d5e    DYNAMIC  Gi1/0/3` → `MAC_001    DYNAMIC  Gi1/0/3` |
| `hostname` | FQDNs ending in `.com .net .org .io .co .local .internal .corp .lan .private .gov .edu .info .telco .telecom` | `core-sw01.dc1.operator.com` → `HOST_001` |

**How aliases behave:**

- **Consistent within a message.** The same value gets the same alias (IPv6 and
  MAC addresses regardless of upper/lower case), and
  different values get different numbers:
  `IMSI 420011234567890 … IMSI 420011234567890 … 420019999999999` →
  `IMSI_001 … IMSI_001 … IMSI_002`.
- **Numbered per message.** Numbering restarts with each message, so
  `IMSI_001` in two different messages may be two different subscribers. To
  correlate across messages, send the related output together.
- **Not reversible.** Nothing stores the alias-to-value mapping, so neither
  the AI provider nor DeepConsol can map an alias back to the real value.
- **Private addresses are kept on purpose.** IPv4 `10/8`, `172.16/12`,
  `192.168/16`, `127/8`, `169.254/16`, `0/8`, `255/8` and IPv6 `::1`,
  `fe80::/10`, `fc00::/7` stay readable, so the AI can follow your internal
  topology. If your internal addressing is
  sensitive, add custom rules for those prefixes (see below).
- **Order matters.** Custom redactions run first, then built-in redactions, then
  built-in aliases, then custom aliases. A value already replaced by an earlier
  rule isn't matched again.

### Tuning the filters (Admin → Filters)

The built-in rules are a **locked baseline**. Admins can switch any rule **on or
off**, but its pattern can't be edited, so a typo can never weaken the core
protection. On top of the baseline, admins add **custom rules**:

| Field | Options |
|---|---|
| Label | Name shown in the admin UI; also used in the redaction tag (`[REDACTED:<LABEL>]`) |
| Match type | **Literal** text, or **wildcard**: `*` = any run of non-space characters, `?` = exactly one character. No raw regex, so no risk of catastrophic regex backtracking (ReDoS). |
| Action | **Redact**, or **Pseudonymize** with your own alias prefix |
| Case-insensitive | On by default |
| Enabled | Switch a rule off without deleting it |

A **Test filters** box shows exactly what the current settings would mask in a
sample you paste, before you rely on them.

**Examples** (actual output):

| Need | Custom rule | Result |
|---|---|---|
| Alias **national MSISDNs** with your own prefix (and disable the generic `msisdn` rule) | Wildcard `9665????????` → Pseudonymize, prefix `SUB` | `drop for 966501234567` → `drop for SUB_001` |
| Hide a **customer name** | Literal `Acme Telecom` → Redact, label `Customer` | `acme telecom reports…` → `[REDACTED:CUSTOMER] reports…` |
| Alias **site codes** | Wildcard `RYD-SITE-*` → Pseudonymize, prefix `SITE` | `RYD-SITE-0042 … RYD-SITE-0042` → `SITE_001 … SITE_001` |
| Keep **hostnames** readable (lower-risk environments) | Disable built-in `hostname` | `core-sw01.dc1.operator.com` stays as is |
| Mask **internal IP ranges** too | Wildcard `10.20.*` → Pseudonymize, prefix `MGMT_IP` | `10.20.0.1 … 10.20.3.9 … 10.20.0.1` → `MGMT_IP_001 … MGMT_IP_002 … MGMT_IP_001` |
| Cisco **plaintext / type 8 / type 9** secrets | Wildcards `password 0 *`, `secret 8 *`, `secret 9 *` → Redact | `password 0 Sup3r!` → `[REDACTED:…]` |
| **TACACS+ / RADIUS keys** | Wildcards `tacacs-server key * *` (with a type digit) and `radius-server key *` → Redact | `tacacs-server key 7 0822455D0A16` → `[REDACTED:…]` |

`*` matches **one word** (no spaces). For `key 7 <secret>`, use one `*` per
word (`key * *`), or the secret after the type digit stays visible. Always
check new rules in **Test filters**.

**How changes take effect:**

- **API:** immediately.
- **Ingestion worker:** within 30 seconds.
- **Browsers:** the next time the workspace tab regains focus, and always right
  before a Send to Chat or Copy Sanitized.
- Every change is audit-logged (`sanitizer_config.*`).
- Re-index existing documents if you want new rules applied to them.

**It fails closed.** If the custom settings can't be loaded (database error,
network failure, page still loading), the **full built-in baseline** runs. A
failure can only make sanitization stricter, never weaker.

### Command risk classification

When you copy an AI-suggested command block, the **Review & Copy** dialog
classifies every line ([packages/shared/src/risk.ts](packages/shared/src/risk.ts)).
The block's level is its **riskiest line**:

| Level | Examples of what triggers it | To copy |
|---|---|---|
| **critical** | `write erase`, `format flash:`, `mkfs`, `dd if=`, `rm -rf /`, `halt` / `shutdown` / `poweroff`, `reload in/at`, `factory reset`, `drop database/table`, `truncate table` | Type `I UNDERSTAND` |
| **high** | `commit`, `shutdown` / `no shutdown`, `clear counters/arp/ip/…`, `reset`, `delete`, `remove`, `erase`, `copy running-config startup-config`, `reboot`, `restart`, `configure` / `conf t`, `set system …`, `sudo`, `systemctl stop/disable`, `kill -9`, `iptables -F` | Type `I UNDERSTAND` |
| **medium** | `debug`, `test`, `monitor`, `capture`, `tcpdump`, `ping -f`, `snmpset`, **and anything not recognised** | Confirm |
| **low** | `show`, `display`, `get`, `list`, `ping`, `traceroute`, `nslookup`, `dig`, `netstat`, `cat`, `tail`, `grep` | Confirm |

The server re-checks the level and requires the exact phrase for high and
critical blocks. The audit log records the level, the confirmation method and a
SHA-256 **hash** of the block, never the command text itself. Unrecognised
commands default to *medium*, never *low*.

### Access control

- **Roles:** `engineer` (workspace, terminal, chat, own credentials) and `admin`
  (everything, plus the admin console). The API checks roles on every admin
  endpoint, not just in the UI.
- **Knowledge-base visibility:** each document is `global` (everyone), `group`
  (members of the assigned groups) or `private` (the uploader). The check is
  inside the retrieval SQL, so a chunk a user may not see is never read, sent to
  the AI or cited.
- **Ownership:** saved SSH credentials, terminal sessions and chat threads are
  queried by owner, so users can't open each other's.
- **Teams:** six default groups are created at install (Network, Core, RAN,
  Transport, NOC, Vendor Support) and can be extended in **Admin → Groups**.

### Secrets and sessions

- **Vault:** SSH passwords and keys and the chat and embedding provider API keys
  are encrypted with **AES-256-GCM**, with a fresh IV and an authentication tag per
  value. The key (`SSH_CRED_ENCRYPTION_KEY`) exists only in `.env`, so a database
  dump alone reveals nothing. Stored secrets are never sent back to the browser.
- **Passwords:** bcrypt with cost 12. Minimum length 10 for new passwords.
- **Sessions:** signed JWT (HS256) in an `HttpOnly`, `Secure`, `SameSite=Lax`
  cookie, valid for `JWT_TTL_HOURS` (default 12).
- **Quick-connect credentials** (typed in without saving) are encrypted and held
  in Redis for at most 60 seconds, then deleted when the session starts.

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
- **Limits** — per-user session cap (`TERMINAL_MAX_SESSIONS_PER_USER`) and idle
  timeout. Orphaned session rows are swept on API startup so the cap can't be
  exhausted by crashes.
- **Target policy** — see below.
- **Right-click menu** on a selection: **Send to Chat (sanitized preview)** ·
  **Pin to Drawer** · **Copy Sanitized**. (Normal text selection copy in the
  terminal still copies raw output for your own use.)
- **No automatic path** from terminal to AI — only the explicit, previewed
  actions above.
- **Review & Copy.** Copying AI-suggested commands to the clipboard goes
  through a risk-classified confirmation; high and critical blocks require
  typing `I UNDERSTAND`. See
  [Command risk classification](#command-risk-classification) for the full rules.

---

### Terminal target policy

The terminal gateway runs inside your network, so DeepConsol controls **which
addresses a session may connect to**. Without this, a user could point a
"Telnet session" at the server's own Redis or database, or at the cloud metadata
service, instead of at a network device.

**Always blocked** (not configurable):

| Range | Why |
|---|---|
| `127.0.0.0/8`, `::1` | Loopback: services on this server |
| **Every IP address of this server** (all interfaces, including Docker bridges) | Services bound to `0.0.0.0` are reachable via the server's LAN IP |
| `169.254.0.0/16`, `fe80::/10`, `100.100.100.200`, `fd00:ec2::254` | Link-local, including the cloud metadata endpoints (credentials) |
| `0.0.0.0/8`, `::`, `224.0.0.0/4`, `ff00::/8`, `240.0.0.0/4`, `255.255.255.255` | Unspecified, multicast, reserved, broadcast |

IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is treated as IPv4, so it can't be used to
get around these.

**Configurable in `.env`** (restart the services after a change):

| Setting | Effect | Example |
|---|---|---|
| `TERMINAL_ALLOWED_CIDRS` | If set, **only** these ranges can be reached. **Recommended for production:** list your device management networks. | `10.50.0.0/16,192.168.100.0/24,2001:db8:100::/48` |
| `TERMINAL_DENIED_CIDRS` | Extra ranges to block on top of the built-in list, e.g. Docker networks or other servers in the same subnet | `172.17.0.0/16,172.18.0.0/16` |

With neither set, any address not in the built-in list is allowed, including
private ranges like `10.0.0.0/8`, since that's usually where network devices
are.

**How it's enforced:**

- **Hostnames:** resolved once, and **every** returned address must pass. A
  name that resolves to a public address *and* to `169.254.169.254` is
  refused.
- **Checked at three points:**
  - when a credential is saved;
  - when a session is created (the connect dialog shows the reason);
  - again in the gateway right before connecting, which also covers
    credentials saved before a policy change.
- **Checked IP is used:** the gateway connects to the IP it checked, not the
  hostname, so DNS can't change the destination in between.
- **Audit:** every block is logged as `terminal.target_blocked`, with the
  target, the resolved IP and the reason.

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
`terminal.target_blocked` ·
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

(Full detail: [Security & privacy features](#security--privacy-features).)

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
> In particular, set `TERMINAL_ALLOWED_CIDRS` to your device networks, and use a
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

- **Terminal targets are open by default within the built-in limits.** Until
  you set `TERMINAL_ALLOWED_CIDRS`, users can reach any address that isn't
  blocked, including other servers on the same LAN and Docker networks. Set an
  allow-list for production (see [Terminal target policy](#terminal-target-policy)).
  The policy is configured in `.env`, not yet in the admin UI.
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
  Juniper `$9$` secrets (see the custom-rule examples in
  [Tuning the filters](#tuning-the-filters-admin--filters)). Long plain numbers
  (interface counters, timestamps) can be over-masked as `MSISDN_nnn` /
  `IMSI_nnn`.
- **Bastion / jump-host fields** on saved credentials are stored but not yet used
  for connections.

---

## Contributing & security reports

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup, tests and PR checklist. The most important rule: **never post
real device output, credentials or subscriber data** in issues or PRs.

Found a vulnerability? Please **don't open a public issue**. Report it privately
as described in [SECURITY.md](SECURITY.md).

---

## License

Released under the [MIT License](LICENSE). © 2026 s-ttp.
