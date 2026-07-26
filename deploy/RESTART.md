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

Подставьте свой домен в `--allowed-hosts` (с точкой в начале — корень и все поддомены).

### Portal

```bash
cd ~/hub/project_hub
pm2 delete portal
pm2 start npm --name portal -- run preview -- --host 127.0.0.1 --port 5180 --allowed-hosts .schekochikhin-tools.ru
pm2 save
```

### Budget (finance)

```bash
pm2 delete finance
pm2 start npm --name finance --cwd /var/www/services/budget -- run preview -- --host 127.0.0.1 --port 5173 --allowed-hosts .schekochikhin-tools.ru
pm2 save
```

### Wallet

```bash
pm2 delete wallet
pm2 start npm --name wallet --cwd /var/www/services/wallet -- run preview -- --host 127.0.0.1 --port 5174 --allowed-hosts .schekochikhin-tools.ru
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
- Без `--allowed-hosts` (или `preview.allowedHosts` в vite) Vite покажет: `Blocked request. This host is not allowed`.
- После успешного `pm2 save` список процессов сохранится и поднимется после reboot (если настроен `pm2 startup`).
