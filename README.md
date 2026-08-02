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

Password-only helper:

```bash
npm run password:admin
```

This generates a strong admin password, updates `ADMIN_PASSWORD` in `.env.production`, and prints the matching backend `scrypt` hash. For an already deployed admin, also create a SQL sync file:

```bash
npm run password:admin -- --sql-file /tmp/admin-password-sync.sql
```

Run the SQL against production PostgreSQL to update `admin_users.password_hash` and revoke old admin sessions.

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

### 1. Finish Local Production Secrets

Create or update `.env.production`:

```bash
cp .env.production.example .env.production
```

Fill the real values:

```env
TWELVE_DATA_API_KEY=...
EXPO_PUBLIC_EAS_PROJECT_ID=...
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
ADMIN_PASSWORD=strong-password-with-symbol
```

Or generate and sync only the admin password automatically:

```bash
npm run password:admin
```

Then run:

```bash
npm run release:validate-production
npm run release:local-readiness
npm run qa:final
```

### 2. Prepare VPS

Recommended VPS:

- Ubuntu 22.04 or 24.04
- 2 CPU / 4 GB RAM minimum
- SSH key login
- Firewall allowing only `22`, `80`, and `443`

Install required packages on the VPS:

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log out and back in after adding the Docker group.

### 3. Clone Project On VPS

```bash
sudo mkdir -p /opt/xauusd-signal
sudo chown -R $USER:$USER /opt/xauusd-signal
cd /opt/xauusd-signal
git clone https://github.com/Limbuthitoo/fx-xauusd-indicator.git .
```

Create the production env on the VPS:

```bash
nano .env.production
```

Do not commit this file.

### 4. Cloudflare DNS

In Cloudflare DNS:

- Type: `A`
- Name: `fx`
- Value: VPS public IP
- Proxy status: Proxied
- TTL: Auto

Recommended Cloudflare settings:

- SSL/TLS: Full strict after Certbot succeeds
- WebSockets: On
- Always Use HTTPS: On after HTTPS works
- Cache bypass for `/api/*`

### 5. Validate On VPS

```bash
npm ci
npm run release:validate-production
npm run deploy:vps-preflight
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod config --quiet
```

### 6. Build And Start Docker Stack

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod build
```

Run migrations:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod-tools run --rm migrate
```

Start the production services:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod up -d postgres redis api worker web
```

Check containers:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod ps
```

### 7. Configure Nginx

```bash
sudo cp nginx/cloudflare-real-ip.conf /etc/nginx/conf.d/cloudflare-real-ip.conf
sudo cp nginx/xauusd-signal.conf /etc/nginx/sites-available/xauusd-signal.conf
sudo ln -sf /etc/nginx/sites-available/xauusd-signal.conf /etc/nginx/sites-enabled/xauusd-signal.conf
sudo nginx -t
sudo systemctl reload nginx
```

Enable HTTPS:

```bash
sudo certbot --nginx -d fx.bijaysubbalimbu.com.np
```

After HTTPS works, set Cloudflare SSL/TLS mode to `Full strict`.

### 8. Verify Live Deployment

```bash
API_BASE_URL=http://localhost:7073 ADMIN_EMAIL=your-admin-email ADMIN_PASSWORD=your-admin-password npm run deploy:verify
```

Manual checks:

- `https://fx.bijaysubbalimbu.com.np` opens web dashboard
- Platform admin login works
- Tenant login works
- `/api/health` returns `ok`
- `/api/live/ws` websocket works through Nginx
- Twelve Data guardrail shows healthy usage
- Module 1, 2, and 3 assigned screens load
- Valid entry alert includes entry, SL, TP, direction, module, and scenario
- Mobile test push sends successfully

### 9. Build Mobile APK

After the VPS and domain are live:

```bash
cd apps/mobile
npx eas-cli build -p android --profile production-apk
```

Install the APK on Android and verify:

- Tenant login
- Assigned modules
- Live chart
- Push registration
- Test push
- Valid entry push with entry, SL, TP

### 10. Backups

Create first backup:

```bash
npm run db:backup
```

Install backup timer if using host/systemd backups:

```bash
sudo cp deploy/systemd/xauusd-backup.service /etc/systemd/system/xauusd-backup.service
sudo cp deploy/systemd/xauusd-backup.timer /etc/systemd/system/xauusd-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now xauusd-backup.timer
```

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
