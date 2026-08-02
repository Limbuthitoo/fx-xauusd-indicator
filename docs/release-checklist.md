# Release Checklist

## Before Merge

- `npm ci`
- `npm run release:check`
- `npm run qa:final`
- `npm run deploy:vps-preflight -- .env.production`
- `docker compose --env-file .env.production.example -f docker-compose.yml -f docker-compose.prod.yml --profile prod config --quiet`
- Confirm `.env` and `backups/postgres/*.dump` are not committed.
- Confirm Firebase service-account JSON files are not committed.

## Before Deploy

- Create a fresh backup with `npm run db:backup`.
- Confirm Platform Admin System Health is `HEALTHY`.
- Confirm Redis, PostgreSQL, API, worker, and backup status are healthy.
- Confirm `EMBEDDED_MARKET_DATA_WORKER=false`.
- Confirm Twelve Data thresholds are below the daily limit.
- Confirm Firebase push status is `CONFIGURED` when `PUSH_PROVIDER=firebase`.
- Confirm `PUBLIC_API_BASE_URL` and `EXPO_PUBLIC_API_BASE_URL` use the VPS/domain URL.
- Confirm Cloudflare DNS has `fx.bijaysubbalimbu.com.np` as a proxied `A` record to the VPS IP.
- Confirm Cloudflare SSL/TLS is `Full strict` after Certbot installs the origin certificate.
- Confirm Cloudflare WebSockets are enabled and API cache is bypassed.

## Deploy

- Build production images.
- Run migrations.
- Start `postgres`, `redis`, `api`, `worker`, and `web`.
- Run `npm run deploy:verify`.
- Run Nginx config test with `sudo nginx -t`.

## After Deploy

- Open Platform Admin System Health.
- Confirm worker heartbeat is fresh.
- Confirm Redis is healthy.
- Confirm backup status is healthy.
- Confirm Twelve Data credits are within guardrail.
- Confirm tenant dashboard loads assigned modules.
- Send mobile test push from Platform Admin Settings.
- Confirm `/api/live/ws` works through Nginx so charts update without refresh.
