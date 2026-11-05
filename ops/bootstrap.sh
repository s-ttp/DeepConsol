#!/usr/bin/env bash
# DeepConsol one-shot bootstrap — first-time setup on a fresh Debian/Ubuntu host.
#
# Idempotent: safe to re-run. For a plain rebuild/redeploy after pulling code,
# use ops/install.sh (this script calls it at the end).
#
# What it does:
#   0. Pre-flight checks (ports, Node version, Redis plan) — fails fast, before
#      anything on the host is changed
#   1. Install prerequisites (Node 20, PostgreSQL + pgvector, Redis, Nginx)
#   2. Generate .env with strong random secrets — ONLY if .env doesn't exist
#   3. Create the Postgres role + database + extensions (vector, pg_trgm)
#   4. Create runtime dirs + a self-signed TLS cert (if missing)
#   5. Build, migrate, seed, install systemd + nginx, start, and health-check
#
# Optional overrides (export before running):
#   APP_PUBLIC_HOST=1.2.3.4   # public IP/host (auto-detected otherwise)
#   REDIS_URL=redis://:pw@host:6379/2
#                             # use an existing Redis instead of installing one
#   SKIP_PKG=1                # skip apt package installation (deps already present)
#   SKIP_NODE=1               # never replace the system Node.js (must already be >= 20)
#   CHECK_ONLY=1              # run the pre-flight checks only, change nothing
#
# Usage:
#   ./ops/bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    WARNING: %s\033[0m\n' "$*" >&2; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# psql as the postgres superuser; ON_ERROR_STOP makes SQL errors fatal (without
# it psql exits 0 even when a statement fails).
pg() { sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"; }

# Print "<process>" listening on TCP port $1, or nothing if the port is free.
port_owner() {
  local out
  out="$(sudo ss -ltnpH "sport = :$1" 2>/dev/null || true)"
  [ -n "$out" ] || return 0
  local name
  name="$(printf '%s\n' "$out" | grep -oE 'users:\(\("[^"]+"' | head -1 | sed -E 's/users:\(\("//; s/"$//' || true)"
  echo "${name:-unknown}"
}

is_private_ip() {
  [[ "$1" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|127\.|169\.254\.) ]]
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

PUBLIC_HOST="${APP_PUBLIC_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
PUBLIC_HOST="${PUBLIC_HOST:-127.0.0.1}"
HAVE_ENV=0; [ -f .env ] && HAVE_ENV=1

# ─────────────────────────────────────────────────────────────────────────────
log "[0/6] Pre-flight checks"

# Node: DeepConsol needs >= 20. Upgrading replaces the SYSTEM-WIDE node.
INSTALL_NODE=0
if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt 20 ]; then
  CURRENT_NODE="$(node -v 2>/dev/null || echo none)"
  if [ "${SKIP_NODE:-0}" = "1" ] || [ "${SKIP_PKG:-0}" = "1" ]; then
    die "Node.js >= 20 is required (found: ${CURRENT_NODE}) and SKIP_NODE/SKIP_PKG is set. Install Node 20+ first."
  fi
  INSTALL_NODE=1
  warn "System Node.js is ${CURRENT_NODE}; it will be REPLACED system-wide with Node 20 (NodeSource)."
  warn "Other apps on this host using the system node will be affected. Set SKIP_NODE=1 to abort instead."
fi

# Ports the stack binds. Ports held by DeepConsol's own services (re-run) or by
# nginx on 443 (we only add a site to it) are fine; anything else is a conflict.
check_port() { # port, allowed-owner-regex, description
  local owner; owner="$(port_owner "$1")"
  if [ -n "$owner" ] && ! [[ "$owner" =~ $2 ]]; then
    die "Port $1 ($3) is already in use by '${owner}'. Free it or move that service, then re-run."
  fi
}
check_port 443  '^nginx$' "HTTPS / nginx"
systemctl is-active --quiet deepconsol-api 2>/dev/null || { check_port 5001 '^$' "API"; check_port 5002 '^$' "terminal gateway"; }
systemctl is-active --quiet deepconsol-web 2>/dev/null || check_port 3002 '^$' "web UI"

# Redis plan:
#   existing .env      → keep its REDIS_URL
#   REDIS_URL exported → use that server, don't install Redis
#   otherwise          → install a local password-protected redis-server on
#                        6379, which must not already be taken by something else
REDIS_MODE="install"
if [ "$HAVE_ENV" = "1" ]; then
  REDIS_MODE="keep"
  note "Redis: keeping REDIS_URL from existing .env."
elif [ -n "${REDIS_URL:-}" ]; then
  REDIS_MODE="external"
  note "Redis: using REDIS_URL from the environment (no local install)."
elif [ "${SKIP_PKG:-0}" = "1" ]; then
  REDIS_MODE="external"
  REDIS_URL="redis://127.0.0.1:6379/2"
  warn "SKIP_PKG=1 and no REDIS_URL given — assuming an unauthenticated Redis at ${REDIS_URL}."
else
  owner="$(port_owner 6379)"
  if [ -n "$owner" ]; then
    die "Port 6379 is already in use by '${owner}', so a local Redis can't be installed.
       To reuse that Redis deliberately, re-run with e.g.:
         REDIS_URL=redis://[:password@]127.0.0.1:6379/2 ./ops/bootstrap.sh
       (pick a DB index no other app uses), or free the port."
  fi
fi

if [ "$HAVE_ENV" = "0" ] && is_private_ip "$PUBLIC_HOST" && [ -z "${APP_PUBLIC_HOST:-}" ]; then
  warn "Auto-detected host ${PUBLIC_HOST} is a PRIVATE address. It is written into .env"
  warn "(APP_PUBLIC_URL, CORS) and the TLS cert. If users reach this server via a public"
  warn "IP or DNS name, re-run with APP_PUBLIC_HOST=<that host> (before .env exists)."
fi
note "Pre-flight OK."
if [ "${CHECK_ONLY:-0}" = "1" ]; then
  note "CHECK_ONLY=1 — stopping before making any changes."
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
log "[1/6] System prerequisites"
if [ "${SKIP_PKG:-0}" = "1" ] || ! command -v apt-get >/dev/null 2>&1; then
  note "Skipping apt install (SKIP_PKG set or non-apt host)."
  note "Ensure Node>=20, PostgreSQL 15 (+pgvector +pg_trgm), Redis, Nginx and openssl are installed."
else
  sudo apt-get update -y
  if [ "$INSTALL_NODE" = "1" ]; then
    note "Installing Node.js 20 (NodeSource)…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  sudo apt-get install -y postgresql postgresql-contrib nginx openssl curl
  # pgvector lives in the PostgreSQL project's own apt repo (apt.postgresql.org)
  # on most Debian/Ubuntu releases — add that repo if the distro lacks it.
  PG_MAJOR="$(psql -V | grep -oE '[0-9]+' | head -1)"
  if ! sudo apt-get install -y "postgresql-${PG_MAJOR}-pgvector"; then
    note "pgvector not in the distro repos — adding apt.postgresql.org…"
    sudo apt-get install -y postgresql-common
    sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
    sudo apt-get install -y "postgresql-${PG_MAJOR}-pgvector" \
      || die "Could not install postgresql-${PG_MAJOR}-pgvector. Install pgvector for PostgreSQL ${PG_MAJOR} manually and re-run."
  fi
  sudo systemctl enable --now postgresql

  if [ "$REDIS_MODE" = "install" ]; then
    sudo apt-get install -y redis-server redis-tools
  fi
fi

# Configure the local Redis: loopback-only + a generated password.
if [ "$REDIS_MODE" = "install" ]; then
  REDIS_PASS="$(openssl rand -hex 24)"
  REDIS_CONF=/etc/redis/redis.conf
  [ -f "$REDIS_CONF" ] || die "Expected $REDIS_CONF after installing redis-server."
  sudo sed -i -E 's/^bind .*/bind 127.0.0.1 -::1/' "$REDIS_CONF"
  if sudo grep -qE '^#?[[:space:]]*requirepass ' "$REDIS_CONF"; then
    sudo sed -i -E "s/^#?[[:space:]]*requirepass .*/requirepass ${REDIS_PASS}/" "$REDIS_CONF"
  else
    echo "requirepass ${REDIS_PASS}" | sudo tee -a "$REDIS_CONF" >/dev/null
  fi
  sudo systemctl enable redis-server
  sudo systemctl restart redis-server
  REDIS_URL="redis://:${REDIS_PASS}@127.0.0.1:6379/2"
fi

# ─────────────────────────────────────────────────────────────────────────────
log "[2/6] Environment file (.env)"
if [ "$HAVE_ENV" = "1" ]; then
  note ".env already exists — leaving its secrets untouched."
else
  note "Generating .env from .env.example with fresh random secrets…"
  DB_PASS="$(openssl rand -hex 24)"
  JWT="$(openssl rand -hex 32)"
  KEK="$(openssl rand -base64 32)"
  ADMIN_PW="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-20)"
  # Write with restrictive permissions from the start.
  ( umask 077; cp .env.example .env )
  sed -i \
    -e "s#^APP_PUBLIC_HOST=.*#APP_PUBLIC_HOST=${PUBLIC_HOST}#" \
    -e "s#^APP_PUBLIC_URL=.*#APP_PUBLIC_URL=https://${PUBLIC_HOST}#" \
    -e "s#^DATABASE_URL=.*#DATABASE_URL=postgres://deepconsol:${DB_PASS}@127.0.0.1:5432/deepconsol#" \
    -e "s#^REDIS_URL=.*#REDIS_URL=${REDIS_URL}#" \
    -e "s#^JWT_SECRET=.*#JWT_SECRET=${JWT}#" \
    -e "s#^SSH_CRED_ENCRYPTION_KEY=.*#SSH_CRED_ENCRYPTION_KEY=${KEK}#" \
    -e "s#^SEED_ADMIN_PASSWORD=.*#SEED_ADMIN_PASSWORD=${ADMIN_PW}#" \
    -e "s#^CORS_ALLOWED_ORIGINS=.*#CORS_ALLOWED_ORIGINS=https://${PUBLIC_HOST}#" \
    .env
  chmod 600 .env
  note "Created .env (mode 600). The seed admin password is SEED_ADMIN_PASSWORD in .env."
  note "GEMINI_API_KEY is left as a placeholder — set a real key here or via Admin → LLM Config."
fi

# Verify Redis is reachable with the configured URL before building anything.
REDIS_URL_ENV="$(grep -E '^REDIS_URL=' .env | cut -d= -f2-)"
if command -v redis-cli >/dev/null 2>&1; then
  reply="$(redis-cli -u "$REDIS_URL_ENV" --no-auth-warning ping 2>&1 || true)"
  [ "$reply" = "PONG" ] || die "Redis at REDIS_URL (from .env) did not answer PING: ${reply}"
  note "Redis reachable."
else
  hp="${REDIS_URL_ENV#*://}"; hp="${hp##*@}"; hp="${hp%%/*}"
  timeout 3 bash -c ">/dev/tcp/${hp%%:*}/${hp##*:}" 2>/dev/null \
    || die "Cannot connect to Redis at ${hp} (from REDIS_URL in .env)."
  note "Redis port reachable (redis-cli not installed; auth not verified)."
fi

# Pull the DB password back out of .env (works for generated or pre-existing files).
DB_PASS="$(grep -E '^DATABASE_URL=' .env | sed -E 's#^DATABASE_URL=postgres://[^:]+:([^@]+)@.*#\1#')"

# ─────────────────────────────────────────────────────────────────────────────
log "[3/6] PostgreSQL role + database + extensions"
if pg -tAc "SELECT 1 FROM pg_roles WHERE rolname='deepconsol'" | grep -q 1; then
  pg -qc "ALTER ROLE deepconsol LOGIN PASSWORD '${DB_PASS}'"
else
  pg -qc "CREATE ROLE deepconsol LOGIN PASSWORD '${DB_PASS}'"
fi
if ! pg -tAc "SELECT 1 FROM pg_database WHERE datname='deepconsol'" | grep -q 1; then
  sudo -u postgres createdb -O deepconsol deepconsol
fi
pg -d deepconsol -qc "CREATE EXTENSION IF NOT EXISTS vector" \
  || die "pgvector extension is not installed for this PostgreSQL. Install postgresql-<major>-pgvector (apt.postgresql.org) and re-run."
pg -d deepconsol -qc "CREATE EXTENSION IF NOT EXISTS pg_trgm"
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
    -subj "/CN=${PUBLIC_HOST}" -addext "subjectAltName=${SAN}" 2>/dev/null
  sudo chmod 600 /etc/ssl/deepconsol/server.key
else
  note "TLS cert already present at /etc/ssl/deepconsol/ — keeping it."
fi

# ─────────────────────────────────────────────────────────────────────────────
log "[5/6] Build, migrate, seed, and install services"
bash ops/install.sh

# ─────────────────────────────────────────────────────────────────────────────
log "[6/6] Done"
APP_URL="$(grep -E '^APP_PUBLIC_URL=' .env | cut -d= -f2-)"
note "DeepConsol is up. Browse to: ${APP_URL}/  (accept the self-signed cert)"
note "Login:  $(grep -E '^SEED_ADMIN_EMAIL=' .env | cut -d= -f2-)  — password: SEED_ADMIN_PASSWORD in ${ROOT}/.env"
note "Enable AI: set a provider key in Admin → LLM Config (and Admin → Embeddings)."
