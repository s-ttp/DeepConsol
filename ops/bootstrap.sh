#!/usr/bin/env bash
# DeepConsol one-shot bootstrap — first-time setup on a fresh Debian/Ubuntu host.
#
# Idempotent: safe to re-run. For a plain rebuild/redeploy after pulling code,
# use ops/install.sh (this script calls it at the end).
#
# What it does:
#   1. Install prerequisites (Node 20, PostgreSQL, Redis, Nginx, openssl) if missing
#   2. Generate .env with strong random secrets — ONLY if .env doesn't exist
#   3. Create the Postgres role + database + extensions (vector, pg_trgm)
#   4. Create runtime dirs + a self-signed TLS cert (if missing)
#   5. Build, migrate, seed, install systemd + nginx, and start everything
#
# Optional overrides (export before running):
#   APP_PUBLIC_HOST=1.2.3.4   # public IP/host (auto-detected otherwise)
#   SKIP_PKG=1                # skip apt package installation (deps already present)
#
# Usage:
#   ./ops/bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

PUBLIC_HOST="${APP_PUBLIC_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
PUBLIC_HOST="${PUBLIC_HOST:-127.0.0.1}"

# ─────────────────────────────────────────────────────────────────────────────
log "[1/6] System prerequisites"
if [ "${SKIP_PKG:-0}" = "1" ] || ! command -v apt-get >/dev/null 2>&1; then
  note "Skipping apt install (SKIP_PKG set or non-apt host)."
  note "Ensure Node>=20, PostgreSQL 15 (+pgvector +pg_trgm), Redis, Nginx and openssl are installed."
else
  sudo apt-get update -y
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
    note "Installing Node.js 20 (NodeSource)…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  sudo apt-get install -y postgresql postgresql-contrib redis-server nginx openssl curl
  # pgvector for the installed Postgres major version (best-effort across distros).
  PG_MAJOR="$(psql -V 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 15)"
  sudo apt-get install -y "postgresql-${PG_MAJOR}-pgvector" \
    || sudo apt-get install -y postgresql-15-pgvector \
    || note "Could not auto-install pgvector — install the pgvector package for your Postgres and re-run."
  sudo systemctl enable --now postgresql redis-server || true
fi

# ─────────────────────────────────────────────────────────────────────────────
log "[2/6] Environment file (.env)"
if [ -f .env ]; then
  note ".env already exists — leaving its secrets untouched."
else
  note "Generating .env from .env.example with fresh random secrets…"
  DB_PASS="$(openssl rand -hex 24)"
  JWT="$(openssl rand -hex 32)"
  KEK="$(openssl rand -base64 32)"
  ADMIN_PW="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-20)"
  cp .env.example .env
  sed -i \
    -e "s#^APP_PUBLIC_HOST=.*#APP_PUBLIC_HOST=${PUBLIC_HOST}#" \
    -e "s#^APP_PUBLIC_URL=.*#APP_PUBLIC_URL=https://${PUBLIC_HOST}#" \
    -e "s#^DATABASE_URL=.*#DATABASE_URL=postgres://deepconsol:${DB_PASS}@127.0.0.1:5432/deepconsol#" \
    -e "s#^JWT_SECRET=.*#JWT_SECRET=${JWT}#" \
    -e "s#^SSH_CRED_ENCRYPTION_KEY=.*#SSH_CRED_ENCRYPTION_KEY=${KEK}#" \
    -e "s#^SEED_ADMIN_PASSWORD=.*#SEED_ADMIN_PASSWORD=${ADMIN_PW}#" \
    -e "s#^CORS_ALLOWED_ORIGINS=.*#CORS_ALLOWED_ORIGINS=https://${PUBLIC_HOST}#" \
    .env
  chmod 600 .env
  note "Created .env (chmod 600). Seed admin password: ${ADMIN_PW}"
  note "GEMINI_API_KEY is left as a placeholder — set a real key here or via Admin → LLM Config."
fi

# Pull the DB password back out of .env (works for generated or pre-existing files).
DB_PASS="$(grep -E '^DATABASE_URL=' .env | sed -E 's#^DATABASE_URL=postgres://[^:]+:([^@]+)@.*#\1#')"

# ─────────────────────────────────────────────────────────────────────────────
log "[3/6] PostgreSQL role + database + extensions"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='deepconsol'" | grep -q 1; then
  sudo -u postgres psql -c "ALTER ROLE deepconsol LOGIN PASSWORD '${DB_PASS}'"
else
  sudo -u postgres psql -c "CREATE ROLE deepconsol LOGIN PASSWORD '${DB_PASS}'"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='deepconsol'" | grep -q 1; then
  sudo -u postgres createdb -O deepconsol deepconsol
fi
sudo -u postgres psql -d deepconsol -c "CREATE EXTENSION IF NOT EXISTS vector" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
note "Database 'deepconsol' ready with vector + pg_trgm."

# ─────────────────────────────────────────────────────────────────────────────
log "[4/6] Runtime directories + TLS certificate"
sudo mkdir -p /var/lib/deepconsol/docs /var/lib/deepconsol/uploads /var/log/deepconsol
sudo chown -R "$(id -un):$(id -gn)" /var/lib/deepconsol /var/log/deepconsol
if [ ! -f /etc/ssl/deepconsol/server.crt ]; then
  note "Generating a self-signed cert (10y) for ${PUBLIC_HOST}…"
  SAN="DNS:deepconsol.local,DNS:localhost,IP:127.0.0.1"
  if [[ "$PUBLIC_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SAN="IP:${PUBLIC_HOST},${SAN}"; else SAN="DNS:${PUBLIC_HOST},${SAN}"; fi
  sudo mkdir -p /etc/ssl/deepconsol
  sudo openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout /etc/ssl/deepconsol/server.key \
    -out    /etc/ssl/deepconsol/server.crt \
    -subj "/CN=${PUBLIC_HOST}" -addext "subjectAltName=${SAN}"
  sudo chmod 600 /etc/ssl/deepconsol/server.key
else
  note "TLS cert already present at /etc/ssl/deepconsol/ — keeping it."
fi

# ─────────────────────────────────────────────────────────────────────────────
log "[5/6] Build, migrate, seed, and install services"
bash ops/install.sh

# ─────────────────────────────────────────────────────────────────────────────
log "[6/6] Done"
note "DeepConsol is up. Browse to: https://${PUBLIC_HOST}/  (accept the self-signed cert)"
note "Login:  $(grep -E '^SEED_ADMIN_EMAIL=' .env | cut -d= -f2-)  /  see SEED_ADMIN_PASSWORD in .env"
note "Enable AI: set a provider key in Admin → LLM Config (and Admin → Embeddings)."
