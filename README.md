# Portal

Хаб на корневом домене: каталог подсервисов, единая авторизация и оркестрация деплоя.

## Быстрый старт (локально)

```bash
cp .env.example .env
npm install
npm run db:up          # если Postgres ещё не запущен (тот же DB, что у finance)
npm run db:migrate
npm run dev            # http://localhost:5180
```

## Конфиг сервисов

[`config/services.yaml`](config/services.yaml) — источник правды для UI каталога и sync:

- список сервисов: `id`, `name`, `subdomain`, `repo`, `branch`, `path`, `port`, `pm2Name`, `build`, `start`, `enabled`
- `domain` / `cookieDomain` в yaml — только fallback; в проде задавай в `.env`

Env задаётся один раз в корневом [`.env`](.env.example):

- `DOMAIN`, `COOKIE_DOMAIN`, `PORTAL_URL`, `VITE_PORTAL_URL`, `DATABASE_URL`
- приоритет домена: `DOMAIN` → host из `PORTAL_URL` → `COOKIE_DOMAIN` → yaml
- при sync env копируется в `.env` каждого дочернего сервиса (hub-only ключи `PG_ADMIN_*`, `SERVICES_CONFIG`, `CADDY_*` не копируются)

Публичный API: `GET /api/services`.

## Auth

Владелец `users` / `sessions`. Cookie `session` с `Domain` из `COOKIE_DOMAIN` (например `.example.com`).

Подсервисы на `*.example.com` только проверяют сессию (`GET /api/auth/me`) по той же БД.

## Sync / Caddy

```bash
npm run sync:caddy     # только deploy/Caddyfile.generated + DNS.md
npm run sync           # git pull/build/PM2 для всех enabled + Caddyfile
npm run sync -- --only wallet
```

DNS: см. [`deploy/DNS.md`](deploy/DNS.md) — нужен wildcard `*.example.com`.

## Деплой (Ubuntu / VPS)

После `git pull` на сервере: [`deploy/RESTART.md`](deploy/RESTART.md).

Полный прогон хаба + всех сервисов в PM2:

```bash
chmod +x scripts/deploy-all.sh
./scripts/deploy-all.sh
# или: npm run deploy:all
```

Только дочерние сервисы (хаб не трогать): `SKIP_PORTAL=1 ./scripts/deploy-all.sh`.

Скрипт: git pull/build хаба → PM2 → sync всех enabled из `services.yaml` → `pm2 save` → systemd autostart PM2.

Только хаб: `scripts/deploy.sh`. CI: `.github/workflows/deploy.yml`.
Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`, optional `DEPLOY_PORT`.
