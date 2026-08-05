# XAUUSD Signal Project Memory

Last updated: 2026-08-05

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
- Purpose: Ultimate Liquidity Sweep + Structure Confirmation strategy family for XAUUSD.
- Authoritative strategy source: `ULTIMATE LIQUIDITY SWEEP + STRUCTURE CONFIRMATION STRATEGY MODULE`, Version 1.0.
- The latest Module 2 specification replaces the previous Module 2 behavior. Do not keep old rule gates, old naming, or compatibility fallbacks when they conflict with the new spec.
- Execution: 5-minute candles.
- Context/bias: 15-minute structure/bias.
- Optional precision timeframe: 1-minute later, but MVP should stay 15m + 5m to reduce noise.
- Research posture: conservative, explainable, versioned, and backtested. Do not claim a fixed 70-85% win rate until PostgreSQL backtests prove it.
- Module 2 must not be a simple `sweep detected -> BUY/SELL` rule. Correct flow is:
  - Potential liquidity level.
  - Sweep candidate.
  - Rejection or acceptance.
  - Protected structure identification.
  - BOS/MSS classification.
  - Configurable confirmation plugins.
  - Optional retest.
  - Risk validation.
  - Trade decision and automatic paper trade when setup-ready.
- Module 2 variant engine:
  - Variant version is stored as `ULTIMATE_LIQUIDITY_SWEEP_V1.0`.
  - Current variant metadata is persisted in `setup_candidates.scenario_flags.module2Variant`, plus `variantCode` and `variantVersion`.
  - Research-only variants are recorded for backtesting and learning but must not open automatic paper trades.
  - Paper-entry variants must pass `VARIANT_SELECTED`, which is a final required entry gate.
  - Supported variants:
    - `SWEEP_CLOSE_BACK_INSIDE` research-only.
    - `SWEEP_BOS` research-only.
    - `SWEEP_MSS` research-only.
    - `SWEEP_DISPLACEMENT_RETEST` paper-entry eligible.
    - `SWEEP_EMA_ALIGNMENT` paper-entry eligible.
    - `SWEEP_BOS_RETEST` paper-entry eligible.
    - `SWEEP_MSS_RETEST` highest-priority paper-entry eligible.
  - Web and mobile notification/details should show the selected variant name/code/version when available.
- Terms must be explicit and versioned. Use `POTENTIAL_LIQUIDITY_LEVELS`, not confirmed institutional liquidity.
- `CHoCH` is a UI alias for structure shift; internally classify reversal confirmation as `REVERSAL_MSS`.
- Use only closed candles for confirmed signals. Never use future candles or unconfirmed pivots.
- Liquidity level examples:
  - Previous day/week high/low.
  - Asian, London, New York premarket high/low.
  - ORB high/low.
  - Recent external/internal swing high/low.
  - Equal highs/lows.
  - Round numbers can be record-only initially.
- Liquidity levels are zones, not single prices:
  - `zoneHalfWidth = ATR * zoneToleranceAtr`.
  - Store type, side, price, bounds, priority, touches, cluster size, status, source swings, formed/valid/expiry times.
- Swing detection:
  - Confirmed fractal swings use `leftBars=2`, `rightBars=2`.
  - Swing is confirmed only after right-side candles close to avoid repainting.
  - Minimum prominence baseline: `0.20 ATR`.
  - Equal highs/lows use deterministic tolerance and cluster rules.
- Structure:
  - Maintain internal 5m structure and external 15m structure.
  - Classify HH, HL, LH, LL, EQH, EQL with ATR tolerance.
  - Structure states are `BULLISH`, `BEARISH`, `RANGING`, `TRANSITIONAL`, `UNKNOWN`.
- Protected point logic:
  - Protected low is the meaningful swing low before a bullish impulse that broke structure.
  - Protected high mirrors this for bearish structure.
  - Automatic MSS requires medium/high protected-point confidence.
- Sweep logic:
  - Buy-side candidate: candle high penetrates above a buy-side liquidity zone.
  - Sell-side candidate: candle low penetrates below a sell-side liquidity zone.
  - A sweep is only valid when price rejects or quickly reclaims the level using closed candles.
  - Rejection quality is tracked with `SWEEP_REJECTION_CONFIRMED`.
  - Acceptance/breakout behavior is blocked with `SWEEP_ACCEPTANCE_BLOCK`.
  - Sweep invalidation reasons include `SWEEP_TOO_SMALL`, `SWEEP_TOO_DEEP`, `NO_REJECTION`, `ACCEPTED_BEYOND_LEVEL`, and `POSSIBLE_BREAKOUT`.
  - Conflicting buy-side and sell-side sweeps inside the recent decision window are exposed as `DOUBLE_SWEEP_FILTER` warning/evidence, not a hard gate.
  - Liquidity sequence selection ranks level priority and rejection quality before displacement, BOS/MSS, zone, retrace, and confirmation.
  - Baseline sweep penetration: minimum `0.02 ATR`, maximum `0.50 ATR`.
  - Penetration below minimum is an insignificant touch.
  - Penetration above maximum is a possible breakout/acceptance warning, not immediate reversal.
  - Support wick sweep, delayed rejection, close-through-then-reclaim, and deep sweep types.
  - Allow multi-candle resolution up to 3 candles.
- Rejection/acceptance:
  - Buy-side rejection needs penetration above and close back below level/zone.
  - Sell-side rejection needs penetration below and close back above level/zone.
  - Wick rejection and engulfing patterns must use formulas.
  - Acceptance beyond the level invalidates reversal logic unless a reclaim variant explicitly permits it.
- BOS/MSS:
  - Bearish break confirms only on closed candle below protected low zone.
  - Bullish break confirms only on closed candle above protected high zone.
  - Break aligned with trend is `CONTINUATION_BOS`.
  - Break opposite prior local structure after sweep is `REVERSAL_MSS`.
  - Wick-only break is not a confirmed MSS/BOS.
- Displacement:
  - Baseline candidate: `rangeAtr >= 1.20`, `bodyRatio >= 0.60`, close distance beyond structure >= `0.05 ATR`.
  - Store direction, candle IDs, body ratio, range ATR, and close distance.
- Confirmation plugin engine:
  - Plugins: structure break, MSS, BOS, engulfing, pin bar, EMA alignment, retest, volume expansion, displacement, session, news.
  - Each plugin returns status `PASS`, `FAIL`, `WAITING`, or `NOT_APPLICABLE`, plus blocking flag, score, actual values, and explanation.
  - Boolean combinations must support AND/OR nesting, e.g. `Sweep AND CloseBackInside AND (MSS OR Engulfing)`.
- EMA filter:
  - Modes: `OFF`, `RECORD_ONLY`, `REQUIRE_ALIGNMENT`, `REQUIRE_COUNTERTREND`, `WARN_ONLY`.
  - Example long alignment: close > EMA200 and EMA20 > EMA50. Short mirrors it.
  - Backtest independently before making it mandatory.
- Volume:
  - XAUUSD/CFD volume may be tick volume. Store volume type and keep volume expansion `RECORD_ONLY` initially.
- Retest:
  - MVP retest target is broken structure level.
  - Later targets can include sweep level, displacement origin, FVG zone, EMA, manual zone.
  - Retest expires by candle count, minutes, session expiry, opposite structure break, or sweep extreme invalidation.
- Entry/stop/target:
  - Entry models: break close, retest close, retest limit, displacement 50%, manual.
  - Baseline stop: beyond sweep extreme plus ATR buffer.
  - Baseline target: fixed 2R while also recording nearest opposing liquidity.
  - Risk must block invalid stop, RR too low, spread too high, news block, stale data, daily risk, and active trade conflicts.
- Module 2 state machine:
  - `IDLE`
  - `LEVEL_SELECTED`
  - `SWEEP_CANDIDATE`
  - `SWEEP_CONFIRMED`
  - `WAITING_FOR_CONFIRMATION`
  - `STRUCTURE_BREAK_CANDIDATE`
  - `STRUCTURE_BREAK_CONFIRMED`
  - `WAITING_FOR_RETEST`
  - `RETEST_REACHED`
  - `ENTRY_READY`
  - `TRADE_ACTIVE`
  - `TRADE_CLOSED`
  - `INVALIDATED`
  - `EXPIRED`
- All state transitions and reasons must be journaled.
- Main short flow:
  - Validate data/session.
  - Update ATR, swings, structure, liquidity levels.
  - Rank active buy-side levels.
  - Detect penetration above level.
  - Validate penetration and rejection.
  - Find protected low.
  - Confirm candle close below protected low.
  - Classify bearish MSS/BOS.
  - Evaluate displacement/plugins.
  - Enter at break close or wait for retest.
  - Calculate entry, stop, TP, RR.
  - Apply spread/news/session/risk checks.
  - Output short setup ready, open paper trade, notify user.
- Main long flow mirrors short using sell-side liquidity, reclaim, protected high, bullish MSS/BOS, long entry, SL, TP.
- Recommended baseline config:
  - Context `15min`, setup `5min`, entry `5min`.
  - Swing left/right bars `2/2`, minimum prominence `0.20 ATR`.
  - Liquidity zone tolerance `0.02 ATR`, equality tolerance `0.05 ATR`.
  - Sweep min/max penetration `0.02/0.50 ATR`.
  - Structure requires candle close, minimum break distance `0.03 ATR`, body ratio `0.50`.
  - Displacement record-only initially with range `1.20 ATR`, body ratio `0.60`.
  - Entry model `RETEST_CLOSE`, maximum retest candles `6`, retest tolerance `0.05 ATR`.
  - Stop model `SWEEP_EXTREME`, buffer `0.03 ATR`.
  - Target fixed `2R`.
  - Risk baseline minimum RR `1.5`, maximum one trade per session/day depending final config.
- Variant backtests must compare:
  - Sweep + close back inside.
  - Sweep + engulfing.
  - Sweep + MSS.
  - Sweep + MSS + retest.
  - Sweep + BOS.
  - Sweep + BOS + retest.
  - Sweep + MSS + EMA.
  - Sweep + MSS + volume.
  - Sweep + MSS + displacement.
  - Sweep + MSS + retest + displacement.
- Backtest reports must include setup count, trade count, win rate, average win/loss R, expectancy, profit factor, drawdown, consecutive losses, holding time, liquidity-level performance, long/short performance, session performance, spread sensitivity, and parameter stability.
- Required test cases include no MSS expiry, wick-only protected-point break, valid MSS close, no retest expiry, valid retest setup, acceptance invalidation, equal high/low clustering, stale data block, RR too low block, double-sweep warning/evidence, and low-confidence protected-point block.
- UI must show every setup with:
  - Liquidity type, price, zone, priority, age, cluster size.
  - Sweep penetration, normalized penetration, sweep candle, rejection type.
  - Structure trend, protected point, break close, break distance, BOS/MSS subtype.
  - Plugin results with blocking status, actual values, and explanation.
  - Risk entry, stop, target, RR, lot size/paper size, max loss.
  - Decision: ready, waiting, blocked, invalidated, expired.
- Module 2 implementation order:
  - Phase 1: candles, ATR, pivots, structure, session levels.
  - Phase 2: liquidity levels, equal highs/lows, sweep, rejection/acceptance. Implemented in production gate with sweep invalidation evidence.
  - Phase 3: protected points, BOS/MSS, displacement.
  - Phase 4: plugin engine, retest, EMA, candle patterns, volume.
  - Phase 5: risk, notifications, journal.
  - Phase 6: backtesting, variant comparison, analytics.
- Module 2 notifications should describe the current state, not only final entries:
  - Approaching liquidity.
  - Penetration detected, waiting for rejection.
  - Sweep confirmed, waiting for MSS.
  - Protected point touched, waiting for candle close.
  - MSS confirmed, waiting for retest.
  - Retest zone reached.
  - SHORT/LONG setup ready.
  - Invalidated or expired with reason.

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
- Module 2 backtests must include variant analytics: each trade stores the selected variant, variant performance is summarized by win rate/R/PF/drawdown, and near-miss variants explain which one or two rules blocked a possible setup.
- Module 2 QA/replay must expose the real variant families: sweep-only research, sweep+BOS research, sweep+MSS research, displacement retest, BOS retest, and EMA-aligned sweep. Backtest UI should show missed setup instructions and evidence markers for swept liquidity, displacement, BOS/CHoCH, FVG/OB zone, and entry/SL/TP.
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
