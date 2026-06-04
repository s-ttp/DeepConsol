#!/usr/bin/env bash
# Push the local repo to GitHub using a Personal Access Token.
#
# The token is read from the GITHUB_TOKEN environment variable and is injected
# into the push URL only for the duration of the command — it is NEVER written
# to .git/config or committed. Do not hardcode a token in this file.
#
# Usage:
#   GITHUB_TOKEN=ghp_xxx ./ops/publish.sh
#   GITHUB_TOKEN=ghp_xxx ./ops/publish.sh https://github.com/<owner>/<repo>.git main
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE_URL="${1:-$(git remote get-url origin 2>/dev/null || echo '')}"
BRANCH="${2:-$(git symbolic-ref --short HEAD 2>/dev/null || echo main)}"

: "${GITHUB_TOKEN:?Set GITHUB_TOKEN to a GitHub PAT, e.g. GITHUB_TOKEN=ghp_xxx ./ops/publish.sh}"
[ -n "$REMOTE_URL" ] || { echo "No remote URL. Pass one: ./ops/publish.sh https://github.com/owner/repo.git" >&2; exit 1; }

case "$REMOTE_URL" in
  https://*) HOST_PATH="${REMOTE_URL#https://}" ;;
  *) echo "Remote must be an https:// URL (got: $REMOTE_URL)" >&2; exit 1 ;;
esac
# Drop any existing creds in the URL before injecting the token.
HOST_PATH="${HOST_PATH##*@}"

echo "==> Pushing HEAD -> ${BRANCH} on ${HOST_PATH}"
git push "https://${GITHUB_TOKEN}@${HOST_PATH}" "HEAD:${BRANCH}"
echo "==> Done. (Token was not persisted to .git/config.)"
echo "    Tip: revoke the PAT when you're finished — GitHub > Settings > Developer settings > PATs."
