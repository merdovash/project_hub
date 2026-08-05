# Перезапуск после `git pull`

Рабочая директория на сервере (пример): `~/hub/project_hub`.

Перед командами: `cd ~/hub/project_hub` и подхватите Node (`nvm use`, если нужно).

Команды вставляйте **по одной** — не копируйте целый блок целиком.

## GitHub Action: Redeploy project_hub

В репозитории [project_hub](https://github.com/merdovash/project_hub) workflow
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

1. SSH на VPS (`DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY`).
2. `cd $DEPLOY_PATH` → `git fetch` + `reset --hard origin/master`.
3. Запуск скрипта в зависимости от `mode`:

| Mode | Скрипт | Что делает |
|------|--------|------------|
| `all` (по умолчанию, в т.ч. на push в `master`) | `./scripts/deploy-all.sh` | хаб (ci/migrate/build/PM2) + sync всех enabled-сервисов + Caddy + `pm2 save` |
| `hub` | `./scripts/deploy.sh` | только хаб + Caddyfile |
| `hub-and-sync` | `SYNC_SERVICES=1 ./scripts/deploy.sh` | хаб + sync подсервисов |

Ручной запуск: GitHub → Actions → **Redeploy project_hub** → Run workflow → выбрать `mode`.

Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH` (путь к `project_hub` на сервере), optional `DEPLOY_PORT`.

## Рекомендуемый способ (полный деплой вручную)

Подтягивает хаб, гоняет миграции БД, собирает, перезапускает PM2, синхронизирует enabled-сервисы (включая `db:migrate`) и Caddyfile:

```bash
cd ~/hub/project_hub
git pull origin master
chmod +x scripts/deploy-all.sh
./scripts/deploy-all.sh
```

Или:

```bash
npm run deploy:all
```

Только дочерние сервисы (хаб не трогать):

```bash
SKIP_PORTAL=1 ./scripts/deploy-all.sh
```

Только хаб:

```bash
./scripts/deploy.sh
```

## Если менялся только код хаба (portal)

```bash
cd ~/hub/project_hub
git pull origin master
npm ci
npm run db:migrate
npm run build
./scripts/deploy.sh
```

`deploy.sh` сам вызовет `db:migrate`, перезапустит PM2 и обновит Caddyfile.

## Если менялись подсервисы (budget / wallet)

Из каталога хаба:

```bash
cd ~/hub/project_hub
npm run sync
```

Один сервис:

```bash
npm run sync -- --only wallet
```

Sync: `git fetch` → если есть новые коммиты: `npm ci` → **`db:migrate`** → `build` → PM2.
Без обновлений в git и при живом процессе — сервис не трогается.
Принудительно: `npm run sync -- --force` (или `--only wallet --force`).

Если таблиц ещё нет (ошибка `relation "wallet_settings" does not exist`), достаточно:

```bash
cd /var/www/services/wallet
npm run db:migrate
```

или полный sync из хаба (см. выше).

## Только Caddy (DNS / домен / список сервисов)

Проверьте `.env`:

```env
DOMAIN=schekochikhin-tools.ru
COOKIE_DOMAIN=.schekochikhin-tools.ru
PORTAL_URL=https://schekochikhin-tools.ru
VITE_PORTAL_URL=https://schekochikhin-tools.ru
```

Затем:

```bash
npm run sync:caddy
sudo cp deploy/Caddyfile.generated /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Ручной перезапуск PM2 (если скрипт недоступен)

Vite preview **не** принимает CLI `--allowed-hosts` (из‑за него процесс падает с `Unknown option`).
Хост разрешается через `preview.allowedHosts` в `vite.config` и/или env
`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.ваш-домен.ru`.

### Portal

```bash
cd ~/hub/project_hub
export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.schekochikhin-tools.ru
pm2 delete portal
pm2 start npm --name portal --cwd /root/hub/project_hub -- run preview -- --host 127.0.0.1 --port 5180
pm2 save
```

### Budget (finance)

```bash
export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.schekochikhin-tools.ru
pm2 delete finance
pm2 start npm --name finance --cwd /var/www/services/budget -- run preview -- --host 127.0.0.1 --port 5173
pm2 save
```

### Wallet

```bash
export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.schekochikhin-tools.ru
pm2 delete wallet
pm2 start npm --name wallet --cwd /var/www/services/wallet -- run preview -- --host 127.0.0.1 --port 5174
pm2 save
```

Важно: `--name portal --` (пробелы вокруг имени), не `portal--`.

## Проверка

```bash
pm2 status
curl -sI http://127.0.0.1:5180 | head -5
curl -sI https://schekochikhin-tools.ru | head -10
systemctl status caddy --no-pager
```

Логи при ошибке:

```bash
pm2 logs portal --lines 40 --nostream
pm2 logs finance --lines 40 --nostream
pm2 logs wallet --lines 40 --nostream
journalctl -u caddy -n 40 --no-pager
```

## Замечания

- Снаружи сайт открывается по **домену** (`https://…`), не по `IP:5180` — приложения слушают только `127.0.0.1`, снаружи их отдаёт Caddy на 80/443.
- Не передавайте Vite CLI `--allowed-hosts` — опции нет, preview упадет. Нужны `preview.allowedHosts` в конфиге и/или `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`.
- После успешного `pm2 save` список процессов сохранится и поднимется после reboot (если настроен `pm2 startup`).
