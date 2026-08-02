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
- Confirm `ADMIN_PASSWORD` passes the strong password policy and `ADMIN_SESSION_SECRET` is at least 32 characters.
- Confirm browser auth uses the HttpOnly `xauusd_admin_session` cookie after login.
- Confirm logout clears the auth cookie and records an `AUTH_LOGOUT` security event.
- Confirm platform super admin 2FA is enabled and visible in Platform Admin > System.
- Confirm password reset tokens expire after 30 minutes and reset completion revokes active sessions.
- Confirm active/revoked admin sessions are visible in the platform security audit.
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
