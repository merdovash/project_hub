#!/usr/bin/env bash
# Deploy portal itself under PM2, then regenerate Caddyfile (and optionally sync services).
set -euo pipefail

cd "$(dirname "$0")/.."

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

BRANCH="${DEPLOY_BRANCH:-master}"
APP_NAME="${PM2_APP_NAME:-portal}"
PORT="${PREVIEW_PORT:-5180}"
SYNC_SERVICES="${SYNC_SERVICES:-0}"

echo "==> Fetching $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "==> Installing dependencies"
npm ci

echo "==> Building"
npm run build

if ! command -v pm2 >/dev/null; then
  echo "pm2 is required (npm i -g pm2)"
  exit 1
fi

ALLOWED_HOSTS="true"
if [[ -f .env ]]; then
  DOMAIN_VAL="$(grep -E '^DOMAIN=' .env | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  COOKIE_VAL="$(grep -E '^COOKIE_DOMAIN=' .env | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  if [[ -n "${COOKIE_VAL:-}" ]]; then
    ALLOWED_HOSTS="$COOKIE_VAL"
  elif [[ -n "${DOMAIN_VAL:-}" ]]; then
    ALLOWED_HOSTS=".${DOMAIN_VAL#.}"
  fi
fi

echo "==> Restarting $APP_NAME (vite preview on :$PORT, allowedHosts=$ALLOWED_HOSTS)"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
# Vite preview has no CLI --allowed-hosts; vite.config + env handle Host checks.
if [[ "$ALLOWED_HOSTS" != "true" ]]; then
  export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="$ALLOWED_HOSTS"
fi
pm2 start npm --name "$APP_NAME" -- run preview -- --host 127.0.0.1 --port "$PORT"
pm2 save

echo "==> Regenerating Caddyfile"
node ./scripts/sync-services.mjs --caddy-only

if [[ "$SYNC_SERVICES" == "1" ]]; then
  echo "==> Syncing all subservices"
  node ./scripts/sync-services.mjs
fi

echo "==> Done"
pm2 describe "$APP_NAME" | head -n 20
