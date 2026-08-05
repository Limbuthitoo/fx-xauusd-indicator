# XAUUSD Signal Project Memory

Last updated: 2026-08-04

## Product Goal

XAUUSD Signal is a production-ready trading indicator and paper-trading system for user accounts. It uses one shared XAUUSD market feed from Twelve Data, stores candles in PostgreSQL, evaluates assigned strategy modules, generates BUY/SELL setup cards, opens automatic paper trades, sends web/mobile notifications, and keeps journal/report/learning records.

The system does not execute broker orders. All broker/MT5 behavior has been removed or deprecated. Users execute manually if they choose; the platform only gives signals and paper-trade tracking.

## Core Architecture

- `apps/api`: Node/Fastify backend, PostgreSQL access, auth, dashboards, market-data scheduler, strategy evaluation, paper trades, notifications, app update uploads.
- `apps/web`: React tenant dashboard and platform admin dashboard.
- `apps/mobile`: Expo/React Native mobile app for tenant login, module views, chart, journal, notifications, push settings, app update flow.
- `packages/strategy-engine`: Module 1 ORB MAX Options logic.
- `packages/liquidity-sweep-engine`: Module 2 Liquidity Sweep + BOS logic.
- `packages/risk-engine`: Paper-trade risk and reward calculations.
- `packages/rule-engine`: Rule evaluation helpers.
- `scripts/quant`: Python strategy brains and learning automation used by the quant service.
- `db/migrations`: PostgreSQL schema and seed migrations.
- `docker-compose.yml` + `docker-compose.prod.yml`: Production containers.

Production services:

- `postgres`: PostgreSQL database.
- `redis`: cache and guardrail dependency.
- `api`: backend HTTP/WebSocket API.
- `worker`: dedicated market-data and strategy worker.
- `web`: Vite preview server behind Nginx.
- `quant`: Python brain service.
- `ops-monitor`: health monitor.
- `backup`: scheduled PostgreSQL backup container.

Domain:

- Production domain: `fx.bijaysubbalimbu.com.np`
- Cloudflare DNS/proxy is used.
- Nginx terminates origin routing to local Docker ports.

## Market Data Rules

- Provider: Twelve Data.
- Symbol: XAUUSD.
- Provider symbol: `XAU/USD`.
- One shared feed is used for every strategy module. Modules must not call Twelve Data directly.
- Candles are stored in PostgreSQL and also cached for fast chart loading.
- Raw candle retention is 7 days.
- Default execution candle timeframe is 5 minutes.
- Module bias/context can use derived 15-minute candles from stored 5-minute data.
- Twelve Data credits are protected:
  - NY live session polling: every 1 minute.
  - Off-session catch-up: every 30 minutes until next NY session.
  - Saturday/Sunday: no live polling and no live paper entries.
  - Safety sync can run if stale before NY starts.

Expected daily usage target:

- NY live polling around 390 credits.
- Off-session 30-minute catch-up around 35 credits.
- Total expected around 425 credits/day under an 800/day free-tier budget.

## Strategy Modules

### Module 1: ORB MAX Options Strategy

- Code: `orb_max_options`
- Purpose: New York ORB strategy for XAUUSD.
- Opening range: 15-minute NY opening range.
- Entry trigger: 5-minute trigger candles.
- Bound to New York session only.
- Must show ORB High, ORB Mid, ORB Low on chart.
- Paper trade opens only when module rules pass.

### Module 2: NY Liquidity Sweep + BOS

- Code: `high_probability_strategy_2`
- Purpose: Liquidity sweep plus market-structure confirmation.
- Execution: 5-minute candles.
- Context/bias: 15-minute structure/bias.
- Must detect and display:
  - Liquidity levels such as London/Asian highs/lows, previous day levels, equal highs/lows.
  - Sweep candle that breaks liquidity and closes back inside.
  - Strong displacement.
  - BOS/CHoCH.
  - FVG/order-block entry zone.
  - Retrace and confirmation candle.
- Hard rules must pass before a valid setup.
- Confirmation and quality filters score the setup.
- Module 2 can continue evaluating outside Module 1 ORB rules where strategy rules allow.

## Predictions

The tenant dashboard includes a `Predictions` sidebar page.

Rules:

- Predictions come from module-owned setup candidates and checklist evaluations stored in PostgreSQL.
- Predictions do not call Twelve Data.
- Module 2 prediction flow is: liquidity level -> sweep close-back -> displacement -> BOS/CHoCH -> FVG/order-block entry zone -> confirmation.
- Prediction cards show BUY/SELL bias, predicted entry zone, SL, TP, probability, evidence, missing blockers, invalidation, and next action.
- Predictions are not guaranteed entries. Paper trades and BUY/SELL cards require the module rules to pass.

## BUY & SELL Page

The tenant dashboard includes a `BUY & SELL` sidebar page.

Rules:

- Cards come only from valid module-generated trade entries.
- Each card includes module name, BUY/SELL action, entry range, SL, TP levels, chance score, setup tier, and trade horizon.
- `Short` tab means intraday/day-trading setup:
  - TP1 = 50 pips.
  - TP2 = 100 pips.
  - TP3 = 150 pips.
  - XAUUSD pip size is treated as `0.01`, so 50 pips = 0.50 price distance.
  - Intended holding time is 4-5 hours, maximum 12 hours.
- `Long` tab means full-checklist setup:
  - Show one strongest full-checklist trade only.
  - Use one TP from the module's main target.
  - Show module and chance score clearly.
- `Chance` is a module confidence/checklist score, not a guaranteed win rate.

## Paper Trading

- Paper trading is automatic.
- No real broker execution.
- A separate `Paper Trading` sidebar page shows table/details for entry, SL, TP, direction, RR, current condition, and status.
- Active paper trades should close automatically on TP/SL or lifecycle rules.
- Journals and reports must be updated from paper-trade lifecycle events.

## Notifications

Web and mobile notifications must support different detail layouts depending on notification purpose:

- Trade setup notification: show action, module, scenario, entry, SL, TP, RR, grade, setup tier, checklist context.
- Paper trade opened: show active paper trade details.
- TP/SL closeout: show lifecycle result.
- Feed/session/system notification: show operational details instead of empty trade cards.
- Tapping a mobile push notification should open the matching notification detail screen.
- Mobile notification detail screen uses purpose-specific templates for trade entry, active paper trade, TP/SL closeout, feed/session/health, and system/learning alerts.

Push provider:

- Firebase Cloud Messaging.
- Mobile app stores FCM tokens through backend.
- Platform verify should show Firebase configured and active push devices.

## Dashboards

### Tenant Dashboard

The tenant dashboard is for individual users, not companies.

Sidebar includes:

- Command Center
- Live Chart
- Predictions
- BUY & SELL
- Paper Trading
- System Status
- Strategy Center
- Reports
- Learning
- Notifications
- My Account
- Settings
- Data Admin

Tenant users should not create other users. Tenant permission management was removed from tenant dashboard.

### Platform Admin Dashboard

Platform admin is separate from tenant dashboard.

Responsibilities:

- Create and manage subscribers.
- Pause/delete subscribers with confirmation for destructive actions.
- Assign modules and plans.
- Manage subscription plans.
- Manage strategy modules.
- View tickets generated by tenants.
- Configure platform settings such as support phone, email, address, help text.
- Upload mobile APK updates.

Platform admin should not log into tenant dashboard as a tenant.

## Mobile App

- Built with Expo/React Native.
- Tenant login only.
- No visible API URL field on login screen.
- Bottom navigation uses icons and separate screens.
- Bottom navigation is Home, BUY & SELL, Live Chart, Paper Trading, More.
- Alerts, push settings, security, module list, chart preferences, support, app updates, and about live inside More.
- BUY & SELL screen uses Short and Long tabs:
  - Short shows actionable intraday setup cards with TP1/TP2/TP3.
  - Long shows the strongest full-checklist setup with one main TP.
  - Tapping a setup opens a trading-ticket detail screen with entry range, entry, SL, TP, RR, chance, grade, paper status, and checklist evidence.
- BUY & SELL screen also keeps module tabs and shows the selected module detail card below actionable setup cards.
- Mobile module detail cards group rule checklists into mandatory gates, confirmation rules, and quality filters.
- More screen contains real menu flows for push settings, modules, chart preferences, security, support, about, app updates.
- Mobile chart reads backend cached candles/websocket only and must not call chart sync or Twelve Data directly.
- Mobile chart focuses on the latest candles on first load and uses compact module legends.
- Mobile chart overlays:
  - Module 1: 15M ORB High/Mid/Low plus paper entry/SL/TP levels.
  - Module 2: liquidity sweep, sweep high/low, BOS/CHoCH, displacement, FVG/OB entry zone, entry/SL/TP.
- Mobile app uses app icon/logo assets from the project.
- APK builds should auto-increase version when using the project build script.

Local APK build command:

```bash
cd "/Users/bijaysubbalimbu/Projects/Forex Trading App/apps/mobile"
npm run build:android-apk:local
```

If using EAS manually:

```bash
cd "/Users/bijaysubbalimbu/Projects/Forex Trading App/apps/mobile"
EXPO_PUBLIC_EAS_PROJECT_ID='93d8c80d-dd63-497a-8e49-b7f6506ee2ab' npx eas-cli build --platform android --profile production-apk --local
```

## App Updates

- Platform dashboard has mobile app update upload.
- Upload form includes APK file, changelog, optional version metadata.
- Backend should auto-detect version where possible.
- New APK upload should replace/delete old APK file to protect server storage.
- Mobile app should detect available updates and show changelog/download details.
- Mobile Home shows an app update banner when a newer active APK is available.
- Opening More refreshes mobile app update status so App Updates has current release metadata.

## Authentication And Security

- Admin/user passwords must be strong.
- Admin password helper can generate/update env password and SQL hash.
- Platform admin may require MFA/OTP.
- MFA should use QR setup for authenticator apps.
- Admin password must be synced to database after `.env.production` changes.
- `ADMIN_SESSION_SECRET` must be a long random secret and must not be left as placeholder.
- Production verify can fail if password policy, MFA, Redis, Firebase, backups, or worker checks fail.

Admin password sync pattern on VPS:

```bash
cd ~/fx-xauusd-indicator
printf '%s\n' 'NEW_ADMIN_PASSWORD' | npm run password:admin -- --password-stdin --sql-file /tmp/admin-password-sync.sql
docker exec -i orb-guide-postgres psql -U orb_user -d orb_guide < /tmp/admin-password-sync.sql
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod up -d api worker ops-monitor web
```

## Production Deployment

Standard VPS update:

```bash
cd ~/fx-xauusd-indicator
git pull origin main

docker compose \
  --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --profile prod-tools \
  run --rm migrate

docker compose \
  --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --profile prod \
  up -d --build postgres redis api worker web quant ops-monitor backup
```

Verify:

```bash
curl https://fx.bijaysubbalimbu.com.np/api/health
curl http://localhost:8000/health

API_BASE_URL='https://fx.bijaysubbalimbu.com.np' \
ADMIN_EMAIL='ADMIN_EMAIL_HERE' \
ADMIN_PASSWORD='ADMIN_PASSWORD_HERE' \
ADMIN_OTP='CURRENT_6_DIGIT_CODE' \
npm run deploy:verify
```

Useful health checks:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod ps
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod logs --tail=120 worker
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod logs --tail=80 ops-monitor
curl https://fx.bijaysubbalimbu.com.np/api/market-data/twelve-data/live/status
```

## Important Recent Commits

- `499612fb`: Optimized live chart loading and streaming.
- `b325ca4d`: Stabilized initial chart viewport.
- `08a5d997`: Added intraday TP1/TP2/TP3 target ladder.
- `27e44214`: Added BUY & SELL Short/Long horizon tabs and chance score.

## Latest Module 1 Direction

- Module 1 ORB is no longer New York-only.
- Module 1 should evaluate ORB sessions for Sydney, Tokyo, London, and New York.
- Each Module 1 ORB session uses a 15-minute opening range and 5-minute trigger candles.
- Module 1 chart should display only the latest two locked session ORB ranges, using session labels such as `TY ORB High/Mid/Low` and `NY ORB High/Mid/Low`.
- Module 1 strategy entry logic should evaluate against the current active session ORB; previous session ORBs are chart/reference context.
- New York keeps the 1-minute live Twelve Data polling cadence.
- Sydney/Tokyo/London ORB evaluation should use the shared 30-minute catch-up candles to protect the 800/day Twelve Data credit budget.
- Module 2 remains separate and uses its Liquidity Sweep + BOS rules.
- Module 3 was intentionally removed completely; do not reintroduce it.

## Operating Principles

- PostgreSQL is the source of truth for candles, setups, paper trades, journals, reports, users, plans, modules, settings, notifications, and app releases.
- Redis is used for cache/guardrails and should be required in production.
- One shared XAUUSD feed supports all modules.
- Strategy logic must remain isolated per module.
- Future modules should reuse shared candles and chart components but keep their own rules, checklist, paper trades, and learning logic.
- Never add broker execution unless explicitly requested later.
- Avoid claiming 70-85% accuracy unless validated with PostgreSQL backtests.
- Backtests should explain missed trades, valid trades, TP/SL result, and checklist reasons.
- Learning brain should use completed paper trades and backtest results, then produce module-specific recommendations.
