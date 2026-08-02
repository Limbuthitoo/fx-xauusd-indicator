# XAUUSD Signal Platform

Production-oriented XAUUSD New York session signal platform with web dashboards, a mobile companion app, PostgreSQL storage, Redis coordination, a shared Twelve Data market feed, paper trading, journaling, reports, and module-based strategy access.

This system is for indicator, alert, journal, and paper-trading workflows. It does not place broker orders and does not guarantee profitable trades.

## Current Status

Local production-readiness is mostly complete.

Ready locally:

- Tenant dashboard
- Platform admin dashboard
- Module 1, 2, and 3 strategy automation foundations
- Shared XAUUSD Twelve Data feed architecture
- PostgreSQL migrations and seed data
- Redis-ready worker coordination
- Mobile app with secure token storage
- Firebase/Expo push notification path
- Nginx, Cloudflare, Docker, backup, and deployment runbooks
- Auth hardening with HttpOnly web cookie, strong password validation, 2FA foundation, session revocation, and security audit trail

Blocked before deployment:

- Real `TWELVE_DATA_API_KEY`
- Firebase service credentials
- Real `EXPO_PUBLIC_EAS_PROJECT_ID`
- VPS IP/login and Cloudflare DNS setup

## Strategy Modules

### Module 1: ORB MAX Options

New York session ORB strategy for XAUUSD.

- 5-minute timeframe
- ORB high/low/midpoint levels
- Strict rule checklist
- Automatic valid setup detection
- Paper trade open with entry, SL, TP
- Journal, reports, QA replay, and readiness checks

### Module 2: NY Liquidity Sweep + BOS

Independent module for New York liquidity sweep plus displacement and BOS/CHoCH.

- 5-minute execution timeframe
- Mandatory hard rules
- Confirmation scoring
- Quality filters
- Trade grade/confidence
- FVG/order-block/sweep/BOS visual evidence
- Paper trade, journal, learning, replay, and backtest tooling

### Module 3: NY VWAP Opening Drive Pullback

Independent VWAP opening-drive pullback module for XAUUSD.

- 5-minute timeframe
- VWAP/opening-drive logic
- Module-specific checklist and paper trading
- Journal, reports, replay, and readiness tooling

## Notifications

All assigned modules can trigger alerts when a valid setup occurs.

Valid-entry and paper-trade notifications include:

- Module name
- BUY/SELL action
- LONG/SHORT direction
- Scenario
- Entry
- Stop loss
- Take profit
- Reward-to-risk
- Grade/confidence when available

Mobile push preferences include:

- NY pre-session reminder
- Valid buy/sell entries
- Paper trade opened
- TP/SL closeouts
- Daily reports
- Weekly/monthly reports
- Learning reviews
- System diagnostics

## Architecture

```text
Cloudflare
  -> Nginx
    -> Web dashboard, Vite preview/static service
    -> Fastify API
      -> PostgreSQL
      -> Redis
      -> Market-data worker
      -> Firebase/Expo push
      -> Quant service

Twelve Data
  -> shared XAUUSD candle fetch
  -> PostgreSQL/cache
  -> module-specific derived candles and strategy engines
  -> websocket chart updates
```

Important rule: Twelve Data is the shared market-data source only. Trade entries, indicators, checklist results, paper trades, journals, and reports are module-specific.

## Stack

- React + TypeScript + Vite web dashboard
- React Native / Expo mobile app
- Fastify TypeScript API
- PostgreSQL
- Redis
- Python FastAPI quant service
- Docker Compose
- Nginx
- Cloudflare
- Firebase Cloud Messaging with Expo fallback

## Local Development

```bash
cp .env.example .env
docker compose up -d postgres redis
npm install
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:web
```

Open:

- Web dashboard: `http://localhost:3000`
- API health: `http://localhost:7073/api/health`

Mobile development:

```bash
npm run dev:mobile
```

For a physical phone, use your Mac LAN IP instead of `localhost`.

## Production Readiness

Run the local readiness report:

```bash
npm run release:local-readiness
```

Expected current result before secrets are added:

- Packaging checks pass
- Mobile production URL passes
- Production secrets readiness is blocked

Full local checks:

```bash
npm run typecheck
npm run build
npm run qa:final
npm run release:check-sensitive
```

Production env validation after secrets are filled:

```bash
npm run release:validate-production
npm run deploy:vps-preflight
```

## Production Environment

Start from:

```bash
cp .env.production.example .env.production
```

Required external values:

```env
TWELVE_DATA_API_KEY=...
EXPO_PUBLIC_EAS_PROJECT_ID=...
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
```

Also set a strong `ADMIN_PASSWORD` with uppercase, lowercase, number, and symbol.

Do not commit `.env`, `.env.production`, Firebase service-account JSON files, or database backups.

## Mobile APK

Local/LAN APK:

```bash
cd apps/mobile
npx eas-cli build -p android --profile preview-apk
```

Production-domain installable APK after VPS is live:

```bash
cd apps/mobile
npx eas-cli build -p android --profile production-apk
```

Play Store app bundle:

```bash
cd apps/mobile
npx eas-cli build -p android --profile production
```

See [apps/mobile/README.md](apps/mobile/README.md).

## Deployment

Primary deployment target:

`https://fx.bijaysubbalimbu.com.np`

Recommended production path:

1. Fill `.env.production`
2. Run local validation
3. Create VPS
4. Point Cloudflare `fx` A record to the VPS
5. Install Docker, Nginx, Certbot
6. Clone repo on VPS
7. Run migrations
8. Start Docker production stack
9. Enable HTTPS
10. Run deployment verification

Runbook:

- [Production deployment](docs/production-deployment-runbook.md)
- [Release checklist](docs/release-checklist.md)
- [Backup and restore](docs/backup-restore-runbook.md)
- [Rollback](docs/rollback-runbook.md)

## Useful Commands

```bash
npm run db:migrate
npm run db:seed
npm run release:local-readiness
npm run release:validate-production
npm run deploy:vps-preflight
npm run qa:final
npm run build
npm run db:backup
```

Docker production config check:

```bash
docker compose --env-file .env.production.example -f docker-compose.yml -f docker-compose.prod.yml --profile prod config --quiet
```

## Security Notes

- Browser auth uses HttpOnly session cookie.
- Mobile token storage uses Expo SecureStore.
- Sessions are stored and revoked through PostgreSQL.
- Platform security audit shows login, logout, failed login, 2FA, reset, and session events.
- Nginx includes Cloudflare real-IP support, rate limits, HSTS, and CSP headers.
- Production must use HTTPS behind Cloudflare/Nginx.

## Market Data Notes

The production worker uses one shared XAUUSD Twelve Data feed. Multiple users and multiple modules do not multiply Twelve Data credits for the same shared source fetch. Modules derive their own strategy timeframes from the shared candle cache.

Twelve Data free-tier planning currently assumes:

- 800 credits/day
- 8 credits/minute
- 1 shared XAUUSD poll/minute during the configured New York session window

## Disclaimer

This project is trading research and automation support software. It is not financial advice, does not execute broker trades, and does not promise any win rate or profit.
