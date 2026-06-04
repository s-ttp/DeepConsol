#!/usr/bin/env bash
# DeepConsol installer for the host-native (no-Docker) deployment pattern.
# Idempotent: safe to re-run after pulling code changes.
#
# What it does:
#   1. npm ci at the workspace root (installs all sub-packages)
#   2. tsc build for shared → api → worker; next build for web
#   3. Run DB migrations + seed (admin, groups, playbooks)
#   4. Drop nginx site config + systemd units
#   5. Reload nginx, enable + start services
#
# Pre-reqs (already done by initial setup):
#   - Postgres 15 with pgvector + pg_trgm extensions
#   - Redis 7 (host-native)
#   - Nginx
#   - Self-signed cert under /etc/ssl/deepconsol/
#   - /var/lib/deepconsol owned by sttp
#   - /home/sttp/deepconsol/.env populated

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> [1/5] Installing npm dependencies ($ROOT)"
npm ci --no-audit --no-fund

echo "==> [2/5] Building all packages"
npm run build:shared
npm run build:api
npm run build:worker
npm run build:web

echo "==> [3/5] Running DB migrations and seed"
node apps/api/dist/db/migrate.js
node apps/api/dist/db/seed.js

echo "==> [4/5] Installing nginx site + systemd units (and node symlink)"
if [ ! -e /usr/local/bin/node ]; then
  sudo ln -sf "$(command -v node)" /usr/local/bin/node
fi
sudo install -m 644 ops/nginx/deepconsol.conf /etc/nginx/sites-available/deepconsol.conf
sudo ln -sfn /etc/nginx/sites-available/deepconsol.conf /etc/nginx/sites-enabled/deepconsol.conf
sudo install -m 644 ops/systemd/deepconsol-api.service    /etc/systemd/system/deepconsol-api.service
sudo install -m 644 ops/systemd/deepconsol-worker.service /etc/systemd/system/deepconsol-worker.service
sudo install -m 644 ops/systemd/deepconsol-web.service    /etc/systemd/system/deepconsol-web.service

echo "==> [5/5] Reloading systemd + nginx and starting services"
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now deepconsol-api deepconsol-worker deepconsol-web
sudo systemctl reload nginx || sudo systemctl restart nginx

echo
echo "DeepConsol services:"
sudo systemctl status --no-pager deepconsol-api deepconsol-worker deepconsol-web | sed -n '1,30p'
echo
echo "OK. Browse to https://${APP_PUBLIC_HOST:-<public-ip>}/  (self-signed cert — accept the warning)"
