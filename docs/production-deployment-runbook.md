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
- `PUBLIC_API_BASE_URL=https://fx.bijaysubbalimbu.com.np`
- `TWELVE_DATA_API_KEY`
- `REDIS_REQUIRED=true`
- `PUSH_PROVIDER=firebase`
- Firebase service-account credentials
- `EXPO_PUBLIC_API_BASE_URL=https://fx.bijaysubbalimbu.com.np`
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
- Cloudflare proxies the public hostname.
- Nginx terminates HTTP/HTTPS on the VPS and proxies `/api` plus `/api/live/ws`.
- Firebase credentials stay outside git, preferably at `/etc/xauusd/firebase-service-account.json`.

## Cloudflare DNS

In Cloudflare DNS, create:

- Type: `A`
- Name: `fx`
- IPv4 address: your VPS public IP
- Proxy status: Proxied
- TTL: Auto

Recommended Cloudflare settings:

- SSL/TLS mode: Full strict after the VPS certificate is installed.
- WebSockets: On.
- Always Use HTTPS: On after Certbot succeeds.
- Minimum TLS version: TLS 1.2 or newer.
- Cache rule: bypass cache for `fx.bijaysubbalimbu.com.np/api/*`.

Keep the root domain and other subdomains separate unless they should also point to this app.

## Build

```bash
npm run build
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod build
```

## Migrate

For the first checksum-ledger deployment to an established database that already has migrations through `079`:

```bash
DATABASE_MIGRATION_BASELINE=079_historical_strategy_validation.sql \
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod-tools run --rm migrate
```

For new databases and every later deployment, omit `DATABASE_MIGRATION_BASELINE`. Never edit an applied migration; the checksum ledger will reject it.

## Start

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod up -d postgres redis quant api worker web ops-monitor backup
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

Copy the templates:

```bash
sudo cp nginx/cloudflare-real-ip.conf /etc/nginx/conf.d/cloudflare-real-ip.conf
sudo cp nginx/xauusd-signal.conf /etc/nginx/sites-available/xauusd-signal.conf
sudo ln -s /etc/nginx/sites-available/xauusd-signal.conf /etc/nginx/sites-enabled/xauusd-signal.conf
sudo nginx -t
sudo systemctl reload nginx
```

The template supports websocket proxying for `/api/live/ws`, which is required for the live chart. It also restores the original visitor IP from Cloudflare's `CF-Connecting-IP` header for logs and rate limiting.

Refresh Cloudflare IP ranges when needed:

```bash
bash scripts/update-cloudflare-real-ip.sh
sudo cp nginx/cloudflare-real-ip.conf /etc/nginx/conf.d/cloudflare-real-ip.conf
sudo nginx -t
sudo systemctl reload nginx
```

For HTTPS:

```bash
sudo certbot --nginx -d fx.bijaysubbalimbu.com.np
```

## Firewall

Expose only:

- `22/tcp` SSH
- `80/tcp` HTTP
- `443/tcp` HTTPS

Docker binds PostgreSQL, Redis, API, web, and quant ports to `127.0.0.1` by default. Keep the firewall closed for those ports unless you explicitly need temporary debugging.

After Cloudflare is verified, you can restrict `80/tcp` and `443/tcp` at the VPS firewall to Cloudflare IP ranges only. Keep SSH protected separately with key login and fail2ban or your VPS provider firewall.

## Verify

```bash
API_BASE_URL=http://localhost:7073 ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=your-password npm run deploy:verify
```

Verification checks API health, PostgreSQL, Redis, dedicated worker heartbeat, Platform System Health, backup status, Twelve Data guardrail, and push provider status.

For upgrades on a database that already has the checksum ledger, prefer:

```bash
ADMIN_OTP='current-six-digit-code' npm run deploy:vps-production -- .env.production
```

This guarded command performs `npm ci`, production environment checks, a PostgreSQL backup, a rebuilt migration run, service rebuild/restart, deterministic BUY/SELL target-sequence tests, migration `082` lifecycle validation, platform health validation, and an HTTP `101` WebSocket upgrade check. Add `TENANT_TOKEN`, or `TENANT_EMAIL` plus `TENANT_PASSWORD`, to include authenticated Prediction, BUY/SELL, notification, paper, and journal proof surfaces.

PostgreSQL-aware validators run inside the API container so they use the same internal `DATABASE_URL` as the healthy production service. To run the production observer check separately:

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  --profile prod exec -T api \
  sh -lc 'cd /app && npm run validate:production-observation'
```

Do not run this validator directly on the VPS host unless you explicitly provide a URL using the published PostgreSQL port and URL-encode any special characters in its password.

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

Set `TWELVE_DATA_INTERVAL=5min`, `TWELVE_DATA_POLL_SECONDS=300`, and `TWELVE_DATA_CATCHUP_SECONDS=300`. On a weekday worker start, the first request gap-fills up to 2,016 recent 5-minute candles, covering seven calendar days in one XAUUSD request. During weekday sessions, the worker performs one shared 5-minute request every 5 minutes. Saturday and Sunday New York dates remain paused. Every source update is persisted to PostgreSQL before strategy evaluation and derives completed 15-minute candles locally for context.

Tenant chart refreshes, readiness actions, strategy engines, and backtests are PostgreSQL-only and never call Twelve Data. The only provider-capable paths are the dedicated worker (`MARKET_DATA_WORKER` / `MARKET_DATA_CATCH_UP`) and the authenticated platform super-admin force-sync endpoint. The normal full weekday estimate is approximately 288-289 credits, including one startup recovery call when needed.

## Mobile APK

Build the APK with the VPS URL:

```bash
cd apps/mobile
EXPO_PUBLIC_API_BASE_URL=https://fx.bijaysubbalimbu.com.np EXPO_PUBLIC_EAS_PROJECT_ID=your-eas-id npx eas-cli build -p android --profile preview-apk
```

After installing:

1. Log in as a subscriber.
2. Open More > Push Alerts.
3. Register Push Alerts.
4. Confirm Firebase token is shown in device status.
5. Send a test push from mobile and Platform Admin.
