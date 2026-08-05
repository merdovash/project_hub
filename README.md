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

- список сервисов: `id`, `name`, `subdomain`, `repo`, `branch`, `path`, `port`, `pm2Name`, `install`, `migrate`, `build`, `start`, `enabled`
- sync: `install` → `migrate` (`npm run db:migrate`, или `migrate: false`) → `build` → PM2
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
npm run sync:caddy     # Caddyfile + установка в /etc/caddy при возможности
npm run sync           # git → при изменениях: ci → migrate → build → PM2
npm run sync -- --only wallet
npm run sync -- --force              # пересобрать/перезапустить даже без git-обновлений
```

Если у сервиса `origin/HEAD` не изменился и процесс уже отвечает — rebuild/restart пропускаются.

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

Скрипт: git pull → `npm ci` → `db:migrate` → build хаба → PM2 → sync сервисов (migrate+build+PM2) → проверка порта → `pm2 save`.

Только хаб: `scripts/deploy.sh`. CI: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) — **Redeploy project_hub**.

### GitHub Action (CI)

Workflow `Redeploy project_hub` (`.github/workflows/deploy.yml`):

| Триггер | Поведение |
|---------|-----------|
| `push` в `master` | полный редеплой (`deploy-all.sh`: хаб + все enabled-сервисы) |
| `workflow_dispatch` → `mode=all` | то же |
| `workflow_dispatch` → `mode=hub` | только хаб + Caddy (`deploy.sh`) |
| `workflow_dispatch` → `mode=hub-and-sync` | хаб + `SYNC_SERVICES=1` |

Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`, optional `DEPLOY_PORT`.
На VPS `DEPLOY_PATH` указывает на checkout хаба (например `~/hub/project_hub`).
