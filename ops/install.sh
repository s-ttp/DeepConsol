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

# Render the systemd units for THIS checkout: substitute the hardcoded
# /home/sttp/deepconsol path and sttp user/group with the actual ROOT and the
# invoking user, so the installer is portable to any path / account.
SVC_USER="$(id -un)"
SVC_GROUP="$(id -gn)"
for unit in deepconsol-api deepconsol-worker deepconsol-web; do
  sed -e "s#/home/sttp/deepconsol#${ROOT}#g" \
      -e "s#^User=sttp#User=${SVC_USER}#" \
      -e "s#^Group=sttp#Group=${SVC_GROUP}#" \
      "ops/systemd/${unit}.service" | sudo tee "/etc/systemd/system/${unit}.service" >/dev/null
done

echo "==> [5/5] Reloading systemd + nginx and starting services"
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable deepconsol-api deepconsol-worker deepconsol-web
# restart (not `enable --now`, which is a no-op for already-running units) so a
# redeploy actually loads the freshly built code.
sudo systemctl restart deepconsol-api deepconsol-worker deepconsol-web
sudo systemctl reload nginx || sudo systemctl restart nginx

echo "==> Health check (waiting up to 60s for services to come up)"
# Each check: label, curl args. A unit that crash-loops or never binds fails here
# instead of being reported as "active (running)" a few ms after start.
check() { # label url [extra curl args...]
  local label="$1" url="$2"; shift 2
  for _ in $(seq 1 30); do
    if curl -fs -o /dev/null --max-time 3 "$@" "$url"; then
      echo "    OK   ${label}"
      return 0
    fi
    sleep 2
  done
  echo "    FAIL ${label} (${url})" >&2
  return 1
}
FAILED=0
check "API            :5001" http://127.0.0.1:5001/health || FAILED=1
check "Terminal WS gw :5002" http://127.0.0.1:5002/health || FAILED=1
check "Web UI         :3002" http://127.0.0.1:3002/login  || FAILED=1
check "nginx → web    :443 " https://127.0.0.1/login -k  || FAILED=1
check "nginx → API    :443 " https://127.0.0.1/api/health -k || FAILED=1
for unit in deepconsol-api deepconsol-worker deepconsol-web; do
  if systemctl is-active --quiet "$unit"; then
    echo "    OK   ${unit} active"
  else
    echo "    FAIL ${unit} is $(systemctl is-active "$unit")" >&2
    FAILED=1
  fi
done
if [ "$FAILED" = "1" ]; then
  echo >&2
  echo "Health check FAILED. Recent logs:" >&2
  sudo journalctl -u deepconsol-api -u deepconsol-worker -u deepconsol-web -n 40 --no-pager >&2 || true
  exit 1
fi

APP_URL="$(grep -E '^APP_PUBLIC_URL=' .env 2>/dev/null | cut -d= -f2- || true)"
echo
echo "OK. Browse to ${APP_URL:-https://<public-ip>}/  (self-signed cert — accept the warning)"
