# Перезапуск после `git pull`

Рабочая директория на сервере (пример): `~/hub/project_hub`.

Перед командами: `cd ~/hub/project_hub` и подхватите Node (`nvm use`, если нужно).

Команды вставляйте **по одной** — не копируйте целый блок целиком.

## Рекомендуемый способ (полный деплой)

Подтягивает хаб, собирает, перезапускает PM2, синхронизирует enabled-сервисы и Caddyfile:

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
npm run build
./scripts/deploy.sh
```

`deploy.sh` перезапустит PM2 с `--allowed-hosts` из `.env` (`COOKIE_DOMAIN` / `DOMAIN`) и обновит Caddyfile.

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

Sync сделает `git pull` в `path` сервиса, `build`, перезапуск PM2 и обновит Caddyfile.

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
