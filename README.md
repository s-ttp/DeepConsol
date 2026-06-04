# DeepConsol

Secure web SSH terminal + Gemini AI copilot for telecom engineers. Three panes
in one screen — terminal (xterm.js over a server-side SSH gateway), context
drawer (client-side staging), and chat (Gemini + RAG). Deliberately not
auto-integrated: terminal output never reaches the AI without the human
explicitly sending it through a sanitization preview.

This MVP runs **host-native** (systemd services, no Docker) on a single Linux
VM, behind Nginx with a self-signed TLS cert.

## Deployment topology

```
              Internet
                 │ TCP 443
                 ▼
       ┌──────────────────┐
       │      Nginx       │   self-signed cert at /etc/ssl/deepconsol/
       │   (TLS termin.)  │
       └──┬──────┬──────┬─┘
   /api/* │      │ /    │ /terminal/connect/*
 (proxy)  │      │      │ (WS upgrade)
          ▼      ▼      ▼
   127.0.0.1:5001  3002  5002
       API         Web   Term-WS
        │           │     │
        └─────┬─────┘     │
              ▼           │
   ┌──────────────────┐   │
   │ Postgres 15 +    │   │
   │  pgvector / trgm │   │
   ├──────────────────┤   │
   │ Redis 7 (db 2)   │◄──┘
   └──────────────────┘

   Worker (BullMQ) ─ pulls ingest jobs from Redis,
                     reads docs from /var/lib/deepconsol/docs
                     embeds via Gemini, stores in pgvector
```

App ports (`3002`, `5001`, `5002`) are bound to `127.0.0.1` only. Only Nginx
(`443`) is publicly reachable.

## Stack

| Layer | Tech |
|------|------|
| Frontend | Next.js 15 (App Router), React 19, Tailwind, xterm.js with fit/search/web-links/unicode/webgl addons |
| Backend API | Fastify 5, TypeScript, Zod, JWT cookies, bcrypt |
| Terminal gateway | Fastify WebSocket plugin, `ssh2` (Node SSH client with PTY) |
| Worker | BullMQ on Redis; pdf-parse / mammoth / jszip+xml2js / exceljs / csv-parse / cheerio |
| RAG store | Postgres 15 + `pgvector` + `pg_trgm` (hybrid retrieval, group-isolated in SQL) |
| AI | Gemini 3 Pro (chat) + Gemini Embedding API; optional Google Search grounding |
| TLS | Self-signed RSA-2048 cert with `IP:34.18.136.125` and `DNS:deepconsol.local` SANs |
| Process mgmt | systemd units (`deepconsol-api`, `deepconsol-worker`, `deepconsol-web`) |

## Repository layout

```
deepconsol/
├── package.json                 # workspace root
├── .env                         # SECRETS — chmod 600, never commit
├── .env.example
├── apps/
│   ├── api/                     # Fastify HTTP + WS terminal gateway
│   ├── worker/                  # BullMQ ingestion worker (parsers + embedder)
│   └── web/                     # Next.js frontend
├── packages/
│   └── shared/                  # browser-safe: types, sanitizer, risk, playbooks
└── ops/
    ├── install.sh               # one-shot install / update
    ├── nginx/deepconsol.conf
    └── systemd/*.service
```

## First-time setup

The infrastructure-side setup was already done by the bootstrap pass:

- `postgresql-15-pgvector` + `nginx` installed
- DB `deepconsol`, role `deepconsol`, extensions `vector` + `pg_trgm` enabled
- Self-signed cert at `/etc/ssl/deepconsol/server.{crt,key}`
- Runtime dirs at `/var/lib/deepconsol/{docs,uploads}` and `/var/log/deepconsol`
- `.env` written with random secrets, Gemini key as **placeholder**

To bring up the app:

```bash
cd /home/sttp/deepconsol
./ops/install.sh
```

That script: `npm ci` → builds all four packages → runs migrations and seed
→ installs nginx site + 3 systemd units → enables and starts everything.

## Logging in for the first time

```text
URL:      https://34.18.136.125/        (accept the self-signed cert warning)
Email:    admin@deepconsol.local
Password: see SEED_ADMIN_PASSWORD in /home/sttp/deepconsol/.env
```

You'll be forced to rotate the password on first login.

## Enabling Gemini

The app ships with `GEMINI_API_KEY=REPLACE_ME_GEMINI_API_KEY` so AI features
return a clear "Gemini not configured" message instead of crashing. To enable:

```bash
sudo -e /home/sttp/deepconsol/.env       # replace GEMINI_API_KEY value
sudo systemctl restart deepconsol-api deepconsol-worker
```

Models default to `gemini-3-pro` (chat) and `gemini-embedding-001` (embeddings).
Override with `GEMINI_CHAT_MODEL` / `GEMINI_EMBEDDING_MODEL` in `.env` if you
want a different one. When grounding is desired, set `GEMINI_WEB_GROUNDING_ENABLED=true`
and switch the chat-mode dropdown to "Web grounded".

After Gemini is enabled, you may want to **reindex** any documents that were
uploaded while the key was a placeholder so they get real embeddings. Open the
Admin → Documents page and click **Reindex** on each one.

## Group isolation model

```text
Visibility = global  → all users
           = group   → users in any of the assigned groups
           = private → owner only
```

Filtering is enforced at the SQL layer in `retrieve()`
([apps/api/src/services/retrieval.ts](apps/api/src/services/retrieval.ts)),
not in the frontend, so unauthorized chunks are never read, embedded into a
prompt, or surfaced as citations.

## Terminal safety model

- Terminal output **never** reaches the chat without explicit user action.
- Right-click on selected terminal text shows: Send to Chat (sanitized) /
  Pin to Drawer / Copy Sanitized / Copy Raw.
- Sanitization runs **twice**: client-side before the text enters the chat
  composer, and server-side again before retrieval, prompt construction,
  Gemini API calls, and chat history storage. See
  [packages/shared/src/sanitizer.ts](packages/shared/src/sanitizer.ts) for the
  full ruleset. SSH keys, API tokens, passwords, customer PII are *removed*;
  IMSI/MSISDN/IMEI/IP/hostname/cell-id are *pseudonymized* per-message
  (IMSI → IMSI_001, IP → IP_001, etc.) so the model can still reason about
  patterns. Private/loopback IP ranges are preserved.
- AI command output cannot be copied with the OS clipboard until the user
  passes through the **Review & Copy** modal. Risk is auto-classified
  (low/medium/high/critical); high & critical require typing `I UNDERSTAND`.
  See [packages/shared/src/risk.ts](packages/shared/src/risk.ts).

## SSH credential vault

Credentials are AES-256-GCM-encrypted in Postgres. The KEK lives in the env
var `SSH_CRED_ENCRYPTION_KEY` (base64-encoded 32 bytes), so DB-only access
cannot reveal them. Each row gets a fresh IV and auth tag.

To rotate the KEK you must re-encrypt every row — there's no rotation tool in
the MVP, so plan the rotation along with a maintenance window.

## Operations

```bash
# Status / logs
sudo systemctl status deepconsol-api deepconsol-worker deepconsol-web
sudo journalctl -u deepconsol-api -f
sudo journalctl -u deepconsol-worker -f
sudo journalctl -u deepconsol-web -f

# Restart after .env change
sudo systemctl restart deepconsol-api deepconsol-worker deepconsol-web

# Re-run migrations after pulling code
cd /home/sttp/deepconsol && npm run build && node apps/api/dist/db/migrate.js
sudo systemctl restart deepconsol-api deepconsol-worker deepconsol-web
```

## Audit events

Logged to the `audit_events` table with redacted metadata only (no raw command
output, no decrypted secrets):

- `auth.login` / `auth.login_failed` / `auth.logout` / `auth.password_rotated`
- `user.created` / `user.updated`
- `group.created` / `group.member_added` / `group.member_removed`
- `ssh_credential.created` / `ssh_credential.deleted`
- `terminal.session_started` / `terminal.session_ended`
- `knowledge.document_uploaded` / `knowledge.document_indexed` / `knowledge.document_visibility_changed` / `knowledge.document_deleted`
- `rag.query` (chunks_returned, high_confidence)
- `chat.message_sent` / `chat.message_received` (provenance, mode)
- `safe_copy.confirmed` (risk_level, content **hash** only)

## Known limitations (MVP)

- Self-signed cert — browsers warn on first visit. Swap to Let's Encrypt once
  a domain points at the host: `sudo apt install certbot python3-certbot-nginx
  && sudo certbot --nginx -d your.domain` and replace the `ssl_certificate*`
  paths in [ops/nginx/deepconsol.conf](ops/nginx/deepconsol.conf).
- No SSO (email/password only) — wire SAML/OIDC via a future enhancement.
- No KEK rotation tool — plan a maintenance window.
- File-system object storage at `/var/lib/deepconsol/docs/`. The
  [`Storage`](apps/api/src/services/storage.ts) interface is abstract so S3/MinIO
  is a drop-in replacement.
- BullMQ jobs persisted in Redis db `2` — share-state with the personaforge
  worker on db `1` is impossible, but if you blow away Redis, queued jobs
  vanish (documents move to `error` status — admin can hit Reindex).
- Reranking, OCR for scanned PDFs, terminal recording/playback, approval
  workflows, vendor-specific command packs — all called out as future work
  in §25 of the build prompt.

## Future work

See §25 of [deepconsol_build_prompt.md](deepconsol_build_prompt.md). The
architecture has clean seams at:

- `Storage` interface (FS → S3/MinIO swap)
- `retrieve()` (add reranker, query rewriting)
- `streamGenerate()` (provider-pluggable; today only Gemini)
- Auth middleware (adding SSO is one more issuer pathway)
