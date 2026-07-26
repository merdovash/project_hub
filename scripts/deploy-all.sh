#!/usr/bin/env bash
# Полный деплой на Ubuntu: хаб + все enabled-сервисы из config/services.yaml → PM2.
#
# Использование:
#   chmod +x scripts/deploy-all.sh
#   ./scripts/deploy-all.sh
#
# Опции (env):
#   DEPLOY_BRANCH=master   ветка хаба
#   SKIP_PORTAL=1          не трогать хаб, только дочерние сервисы
#   SKIP_STARTUP=1         не настраивать автозапуск PM2 после reboot
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

BRANCH="${DEPLOY_BRANCH:-master}"
APP_NAME="${PM2_APP_NAME:-portal}"
PORT="${PREVIEW_PORT:-5180}"
SKIP_PORTAL="${SKIP_PORTAL:-0}"
SKIP_STARTUP="${SKIP_STARTUP:-0}"

echo "==> Portal root: $ROOT"

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "node/npm not found. Install Node.js (nvm recommended) first."
  exit 1
fi

if ! command -v pm2 >/dev/null; then
  echo "==> Installing pm2 globally"
  npm install -g pm2
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

start_portal() {
  echo "==> Restarting hub in PM2 ($APP_NAME :$PORT, allowedHosts=$ALLOWED_HOSTS)"
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  pm2 start npm --name "$APP_NAME" --cwd "$ROOT" -- run preview -- --host 127.0.0.1 --port "$PORT" --allowed-hosts "$ALLOWED_HOSTS"
}

if [[ "$SKIP_PORTAL" != "1" ]]; then
  echo "==> Updating hub ($BRANCH)"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"

  echo "==> Installing hub dependencies"
  npm ci

  echo "==> Building hub"
  npm run build

  start_portal
else
  echo "==> Skipping hub (SKIP_PORTAL=1)"
fi

echo "==> Syncing all enabled services (git/build/PM2) + Caddyfile"
node ./scripts/sync-services.mjs

# Child builds can OOM-kill the hub preview; ensure portal is up at the end.
if [[ "$SKIP_PORTAL" != "1" ]]; then
  echo "==> Ensuring hub is online after sync"
  start_portal
fi

pm2 save

if [[ "$SKIP_STARTUP" != "1" ]] && command -v systemctl >/dev/null; then
  UNIT="pm2-$(whoami)"
  if ! systemctl cat "$UNIT" >/dev/null 2>&1; then
    echo "==> Configuring PM2 systemd startup ($UNIT)"
    # pm2 prints a line to run; execute it when present
    STARTUP_LINE="$(pm2 startup systemd -u "$(whoami)" --hp "$HOME" | grep -E '^(sudo )?env PATH=' | tail -n 1 || true)"
    if [[ -n "$STARTUP_LINE" ]]; then
      eval "$STARTUP_LINE"
      pm2 save
    else
      echo "Run manually: pm2 startup systemd -u $(whoami) --hp $HOME"
    fi
  else
    echo "==> PM2 startup already configured ($UNIT)"
  fi
fi

echo ""
echo "==> Done. Processes:"
pm2 ls
echo ""
echo "Logs: pm2 logs"
echo "Restart one: pm2 restart $APP_NAME"
