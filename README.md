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

- `domain` / `cookieDomain`
- список сервисов: `id`, `name`, `subdomain`, `repo`, `branch`, `path`, `port`, `pm2Name`, `build`, `start`, `enabled`

Env задаётся один раз в корневом [`.env`](.env.example). При `npm run sync` он копируется в `.env` каждого дочернего сервиса (`DATABASE_URL`, `COOKIE_DOMAIN`, `PORTAL_URL`, `VITE_PORTAL_URL`, …). Hub-only ключи (`PG_ADMIN_*`, `SERVICES_CONFIG`, `CADDY_*`) не копируются. Если `PORTAL_URL` / `COOKIE_DOMAIN` не заданы — берутся из `domain` / `cookieDomain` в yaml.

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

## Деплой

`scripts/deploy.sh` + GitHub Actions `.github/workflows/deploy.yml`.
Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`, optional `DEPLOY_PORT`.
