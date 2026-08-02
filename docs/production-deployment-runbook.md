# Production Deployment Runbook

## Required Environment

Start from `.env.production.example` and set real values:

```bash
cp .env.production.example .env.production
```

- `POSTGRES_PASSWORD`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`
- `PUBLIC_API_BASE_URL`
- `TWELVE_DATA_API_KEY`
- `REDIS_REQUIRED=true`
- `PUSH_PROVIDER=firebase`
- Firebase service-account credentials
- `EXPO_PUBLIC_API_BASE_URL=https://your-domain.com`
- `EXPO_PUBLIC_EAS_PROJECT_ID`

Keep `EMBEDDED_MARKET_DATA_WORKER=false`. Production must run API and market-data worker as separate services.

Run the VPS preflight before building:

```bash
npm run deploy:vps-preflight -- .env.production
```

## Recommended VPS Layout

- PostgreSQL and Redis run in Docker with persistent volumes.
- API and market-data worker run as separate services.
- Web runs behind Nginx.
- Nginx terminates HTTP/HTTPS and proxies `/api` plus `/api/live/ws`.
- Firebase credentials stay outside git, preferably at `/etc/xauusd/firebase-service-account.json`.

## Build

```bash
npm run build
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod build
```

## Migrate

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod-tools run --rm migrate
```

## Start

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod up -d postgres redis api worker web
```

## PM2 Alternative

Use PM2 if PostgreSQL/Redis are managed separately or if you prefer host Node processes:

```bash
npm ci
npm run build
npm run db:migrate
npm run pm2:start
npx pm2 save
npx pm2 startup
```

Useful commands:

```bash
npm run pm2:status
npm run pm2:logs
npm run pm2:restart
```

PM2 processes:

- `xauusd-api`
- `xauusd-worker`
- `xauusd-web`

## Nginx

Copy the template and replace `example.com`:

```bash
sudo cp nginx/xauusd-signal.conf /etc/nginx/sites-available/xauusd-signal.conf
sudo ln -s /etc/nginx/sites-available/xauusd-signal.conf /etc/nginx/sites-enabled/xauusd-signal.conf
sudo nginx -t
sudo systemctl reload nginx
```

The template supports websocket proxying for `/api/live/ws`, which is required for the live chart.

For HTTPS:

```bash
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

## Firewall

Expose only:

- `22/tcp` SSH
- `80/tcp` HTTP
- `443/tcp` HTTPS

Keep PostgreSQL, Redis, API, and web preview ports private unless you explicitly need temporary debugging.

## Verify

```bash
API_BASE_URL=http://localhost:7070 ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=your-password npm run deploy:verify
```

Verification checks API health, PostgreSQL, Redis, dedicated worker heartbeat, Platform System Health, backup status, Twelve Data guardrail, and push provider status.

After Firebase credentials are set, open Platform Admin > Settings and run **Send Platform Push Test**.

## Backup

```bash
npm run db:backup
```

Open Platform Admin System Health and confirm PostgreSQL backups are healthy.

## Backup Automation

For host/PM2 deployments, install the systemd timer:

```bash
sudo cp deploy/systemd/xauusd-backup.service /etc/systemd/system/xauusd-backup.service
sudo cp deploy/systemd/xauusd-backup.timer /etc/systemd/system/xauusd-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now xauusd-backup.timer
systemctl list-timers xauusd-backup.timer
```

The template assumes the app lives in `/opt/xauusd-signal` and runs as user `xauusd`. Change those values if your VPS path/user is different.

Before final launch, run:

```bash
npm run qa:final
```

## Shared Twelve Data Feed

The production worker uses one shared XAUUSD Twelve Data feed. Strategy modules derive their own candle logic from that feed, so adding subscribers does not multiply Twelve Data credits for the same symbol/timeframe source.

## Mobile APK

Build the APK with the VPS URL:

```bash
cd apps/mobile
EXPO_PUBLIC_API_BASE_URL=https://your-domain.com EXPO_PUBLIC_EAS_PROJECT_ID=your-eas-id npx eas-cli build -p android --profile preview-apk
```

After installing:

1. Log in as a subscriber.
2. Open More > Push Alerts.
3. Register Push Alerts.
4. Confirm Firebase token is shown in device status.
5. Send a test push from mobile and Platform Admin.
