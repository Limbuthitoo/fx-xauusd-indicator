# XAUUSD Signal Project Memory

Last updated: 2026-08-12

## Product Goal

XAUUSD Signal is a production-oriented trading indicator and signal system for user accounts. It uses one shared XAUUSD market feed from Twelve Data, stores candles in PostgreSQL, evaluates assigned strategy modules, generates predictions and BUY/SELL setup cards, sends web/mobile notifications, opens paper-trade tracking rows for win-rate measurement, and keeps journal/report/learning records. The software is suitable for controlled paper validation; strategy quality is not production-proven until out-of-sample release gates pass.

The system does not execute broker orders. All broker/MT5 behavior has been removed or deprecated. Users execute manually if they choose; the platform only gives signals and paper-trade tracking.

## Core Architecture

### 2026-08-11 MVP runtime repair

- Module 1 and Module 2 strategy evaluation is New York-session only; the shared XAUUSD chart remains completed 5-minute candles with 15-minute context where required.
- The primary product chain is signal first: fresh prediction -> actionable BUY/SELL signal -> notification. Automatic paper tracking follows the same accepted signal and exists to measure outcomes and win rate.
- A database-backed audit found that valid Module 1 opportunities were being calculated but lost because subscribers had no active `risk_profiles` row. Migration `076_seed_tenant_paper_risk_profiles.sql` seeds conservative paper-only defaults, while runtime evaluation also has a safe fallback.
- The Python main brain had a psycopg SQL formatting crash caused by an unescaped `%` in a `LIKE` expression. It is escaped and production verification now checks recent `MAIN_BRAIN_FAILED` events.
- Module 2 sweep candidates are strictly time-ordered: a sweep candle cannot precede the liquidity level's formation or confirmation time. The default execution window is New York 09:30-16:00.
- `npm run validate:mvp-runtime -- .env.production` verifies risk-profile coverage, fresh runtime failures, stored candles, saved-candle NY opportunity replay, stale-price guards, and the setup -> notification -> paper-tracking artifact chain.
- Trade frequency is measured from saved candles; the runtime must never fabricate a setup to satisfy a daily quota.

- `apps/api`: Node/Fastify backend, PostgreSQL access, auth, dashboards, market-data scheduler, strategy evaluation, paper trades, notifications, app update uploads.
- `apps/web`: React tenant dashboard and platform admin dashboard.
- `apps/mobile`: Expo/React Native mobile app for tenant login, module views, chart, journal, notifications, push settings, app update flow.
- `packages/strategy-engine`: Module 1 ORB MAX Options logic.
- `packages/liquidity-sweep-engine`: Module 2 Ultimate Liquidity Sweep + Structure Confirmation logic.
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
- `web`: compiled React SPA served by a dedicated Nginx container behind the VPS Nginx/Cloudflare edge.
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
  - Shared 5-minute candle sync: one XAUUSD call per 5-minute cadence on market weekdays.
  - All modules evaluate from PostgreSQL after the shared candle sync.
  - Saturday/Sunday: no Twelve Data polling and no live paper entries.
  - Safety sync can run if data is stale before a strategy cycle.

Expected daily usage target:

- Full weekday 5-minute cadence is roughly 288 credits/day if running continuously.
- This keeps the shared XAUUSD feed under an 800/day free-tier budget while giving complete 5M candles for all strategy sessions.

## Strategy Modules

### Module 1: ORB MAX Options Strategy

- Code: `orb_max_options`
- Purpose: New York-session ORB strategy for XAUUSD.
- Opening range: 15-minute New York opening range.
- Entry trigger: 5-minute trigger candles.
- Must show New York ORB High, ORB Mid, ORB Low on chart, starting at the New York ORB session open rather than full-width across unrelated history.
- Tenant setting `orb.strategy.chart.showOrbSessionLevels` controls whether Module 1 ORB High/Mid/Low are visible on the live chart. Default is ON, and disabling it hides chart indicators only; it does not disable ORB calculation, signals, predictions, or paper trading.
- Module 1 live chart indicators are module-owned: ORB levels and horizontal range can be toggled independently. They must not leak into Module 2.
- Module 1 live chart should render only the latest/current New York ORB High/Mid/Low until the next New York ORB replaces it. Do not draw previous NY ORB ranges, duplicate NY ranges, or full-width ORB price-line indicators.
- Module 1 ORB High/Mid/Low remain visible while ORB is the active structure. When a horizontal range breakout setup becomes valid/locked, the live chart hides ORB levels and prioritizes the horizontal range display to prevent crowding. ORB calculations remain available, but the horizontal setup can drive the MVP trade flow when its mandatory rules pass.
- Paper-trade tracking opens only to measure validated module signals; predictions and BUY/SELL are the main MVP outputs.

### Module 2: Ultimate Liquidity Sweep

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
- Module 2 live chart indicators are module-owned: EMA, liquidity, sweep, FVG/entry zone, displacement, and MSS/BOS can be toggled independently. ORB-derived liquidity/labels must be filtered out of Module 2 chart overlays and price labels.
- Module 2 must not render ORB High/Mid/Low, ORB-derived sweep levels, or ORB-derived liquidity labels on its live chart, including during zoom/scale redraws.
  - Risk validation.
  - Trade decision, BUY/SELL signal, notification, and secondary paper-trade tracking when setup-ready.
- Module 2 variant-driven production model:
  - Variant version is stored as `ULTIMATE_LIQUIDITY_SWEEP_V1.0`.
  - Current variant metadata is persisted in `setup_candidates.scenario_flags.module2Variant`, plus `variantCode` and `variantVersion`.
  - Variants are independent confirmation profiles evaluated after base liquidity sweep conditions.
  - Sweep-only/no-confirmation is research/control only and must not emit actionable BUY/SELL signals.
  - Signal-approved variants can emit BUY/SELL signals when their own mandatory profile passes with risk approval, signal score, and Python brain approval. Paper-trade tracking mirrors the signal for win-rate measurement.
  - `VARIANT_SELECTED` means one selected independent profile passed; it does not mean every variant must pass.
  - Required live base path: healthy data, active strategy cycle, valid ranked liquidity, sweep, close-back rejection, no acceptance, risk approval, signal score, and a selected signal-approved variant.
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
  - Output short setup ready, notify user, and open paper-trade tracking for measurement.
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
- Prediction cards show BUY/SELL bias, predicted entry zone, SL, TP, setup score, evidence, missing blockers, invalidation, and next action.
- Predictions are early candidate entries. BUY/SELL cards require the module rules to pass and current price to remain near the planned entry. Paper trades are secondary tracking rows for win-rate, journal, report, and learning calculations.

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
- `Setup score` is a deterministic module evidence/checklist score out of 100, not a measured win probability or guaranteed win rate.

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
  - Module 1: 15M ORB High/Mid/Low plus BUY/SELL entry/SL/TP levels.
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

Migration execution uses the checksum-backed `schema_migrations` ledger. For the first ledger-enabled deployment to an established database only, run the migrate container with `DATABASE_MIGRATION_BASELINE=079_historical_strategy_validation.sql`; later migrations must omit the baseline. Applied migration files must never be edited because checksum drift fails deployment.

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

- Module 1 ORB is New York-session only again.
- Module 1 should evaluate only the `NEW_YORK_ORB` session for BUY/SELL signals, predictions, paper trades, journal rows, reports, and notifications.
- Module 1 keeps the existing MAX Options behavior: 15-minute New York opening range built from three 5-minute candles, then 5-minute closed-candle triggers.
- Module 1 horizontal range detection is active only during the New York ORB session and is now an MVP signal path, not observation-only. ORB remains the first-priority signal, but when ORB is not ready and a locked horizontal range has breakout + retest + clear conflict + valid risk, it can create predictions, BUY/SELL cards, paper trades, journal rows, notifications, and chart markers.
- Module 2 is independent from Module 1, but both strategy runtimes are now restricted to the New York window. The shared chart history may continue catching up outside New York.
- All market sessions use the shared XAUUSD 5-minute Twelve Data candle feed. The platform requests one 5M candle sync per 5-minute cadence on market weekdays, then all modules evaluate from PostgreSQL.
- Sydney/Tokyo/London/New York ORB evaluation all use the same shared 5-minute candle cadence to protect the 800/day Twelve Data credit budget.
- Module 2 remains separate and now uses the Ultimate Liquidity Sweep + MSS + Retest production model, not the old `Liquidity Sweep + BOS` strategy.
- Module 2 profile evidence is registry-backed in `module2_strategy_variants` and versioned as `ULTIMATE_LIQUIDITY_SWEEP_V1.0`.
- Module 2 evidence profiles can be tracked for backtesting, but live BUY/SELL output is not a profile comparison system.
- Module 2 actionable live profiles are independent confirmation profiles. One signal-approved variant plus risk, score, and Python brain approval can generate a BUY/SELL signal, notification, and secondary paper tracking.
- Module 2 sweep + no-confirmation remains research/control only. Signal-approved independent profiles are exactly A-I: A sweep close-back, B sweep + BOS, C sweep + MSS, D sweep + engulfing, E sweep + BOS + retest, F sweep + MSS + retest, G sweep + EMA alignment, H sweep + volume expansion, and I sweep + MSS + displacement + retest.
- Module 2 BUY/SELL signals require closed 5M candles, valid base sweep conditions, a selected signal-approved variant, risk guardrails, minimum confidence, Python brain approval, and near-current entry validation. Paper tracking mirrors that signal for performance measurement.
- Module 2 liquidity selection now includes previous week high/low, previous day high/low, Asian high/low, London high/low, NY premarket high/low, ORB high/low, equal high/low, swing high/low, round numbers, and optional manual levels.
- Module 2 confirmation layer currently tracks 10 plugins: 15M/EMA alignment, VWAP, fresh FVG, order-block retest, engulfing candle, pin-bar rejection, inside-bar break, doji rejection, volume expansion, and entry confirmation candle. Volume expansion remains record-only by default because XAUUSD provider volume may be incomplete.
- Module 2 tenant settings include EMA mode (`OFF`, `RECORD_ONLY`, `WARN_ONLY`, `REQUIRE_ALIGNMENT`, `REQUIRE_COUNTERTREND`) and volume mode (`OFF`, `RECORD_ONLY`, `WARN_ONLY`, `REQUIRE_EXPANSION`), plus NY premarket, ORB, round-number, and manual liquidity-level controls.
- Module 2 state transitions are persisted in `module2_state_transitions` so sweep, displacement, BOS/CHoCH, entry-zone, waiting-for-retest, retrace, entry-ready, invalidated, and expired evidence can be audited after the chart moves on.
- Module 2 manual liquidity levels are optional research inputs. Tenant settings sanitize and retain up to 20 manual levels with label, price, side, and priority. The engine treats them as potential liquidity zones only, never confirmed institutional liquidity.
- Module 2 per-variant live paper metrics are exposed through `/api/module2/variant-metrics` and snapshotted into `module2_variant_metric_snapshots`.
- Module 2 backtests may include profile/evidence analytics, but production live performance should be measured primarily against the strict `SWEEP_MSS_RETEST` profile.
- Module 2 missed-trade backtest evidence now includes variant, blocker, missing rule details, projected entry/SL/TP, projected outcome/result R, liquidity/sweep/displacement/structure/entry-zone snapshots, instruction text, and learning notes.
- Module 2 QA/replay must expose the real A-J variant families independently: A sweep close-back, B sweep+BOS, C sweep+MSS, D sweep+engulfing, E sweep+BOS+retest, F sweep+MSS+retest, G sweep+EMA alignment, H sweep+volume expansion, I sweep+MSS+displacement+retest, and J sweep+no-confirmation control. Backtest UI should show missed setup instructions and evidence markers for swept liquidity, displacement, BOS/CHoCH, FVG/OB zone, and entry/SL/TP.
- Module 2 live evidence must stay aligned across live chart, Strategy Center, Predictions, BUY & SELL, web notifications, and mobile notification detail. These views should show variant, mandatory/confirmation/quality counts, missing blocking rules, liquidity, displacement, BOS/CHoCH, entry zone, and entry/SL/TP when available.
- Module 2 Predictions page only shows 80%+ candidates and now surfaces selected variant name/code/status, variant waiting rules, liquidity/sweep/displacement/BOS/entry-zone evidence, HTF bias, confirmation count, and quality count.
- Module 2 variant metrics table now includes live paper trades, win rate, average R, profit factor, max drawdown R, top blocker, blocker count, and recommendation.
- Module 2 backtests should create missed-trade learning review items. Reviews must preserve variant, blocker, missing rules, projected entry/SL/TP, projected TP/SL outcome, classification, guardrails, and proposed QA-only/observe-only next action.
- Module 2 production validation command is `npm run validate:module2-production -- .env.production`. It checks PostgreSQL 5M candles, Module 2 catalog/tenant assignment, latest cache backtest, 80%+ predictions, entry-ready setup chain, paper trade, notification payload, journal, and learning review evidence.
- Latest Module 2 final contract implemented from `LIQUIDITY SWEEP + MSS + RETEST COMPLETE VALID TRADE ENTRY ENGINE FOR SOFTWARE`.
- Module 2 engine path is now: market data -> data health -> session -> market context -> market regime -> swing detection -> liquidity detection/ranking -> sweep -> rejection/acceptance -> protected structure -> reversal MSS -> retest -> context filters -> conflict resolution -> risk -> confidence -> BUY_READY/SELL_READY/WAIT/BLOCK/INVALIDATE/EXPIRE.
- Module 2 data health states are `HEALTHY`, `DELAYED`, `STALE`, `DISCONNECTED`, `INCONSISTENT`, and `RATE_LIMITED`. Non-healthy data blocks live paper-entry decisions.
- Module 2 base mandatory signal gates now include data health, active strategy cycle, daily signal limit, active setup conflict, paper-tracking duplicate guard, daily/weekly/consecutive-loss risk limits, manual-confirmation mode, ranked liquidity level, sweep, close-back rejection, no acceptance, risk engine, signal score, and selected variant. Market context/regime are evidence unless configured as required. Variant-specific requirements such as BOS, MSS, protected point, retest, displacement, EMA, engulfing, or entry candle belong to the selected independent profile.
- Module 2 displacement is context by default (`WARN_ONLY`), not mandatory unless `displacementFilterMode` is set to `REQUIRED`.
- Module 2 EMA defaults to `WARN_ONLY`; volume defaults to `RECORD_ONLY`; market context defaults to `RECORD_ONLY`; manual confirmation defaults to `false` for automatic BUY/SELL signal flow.
- Module 2 ranked liquidity now scores previous week/day, London, Asian, ORB, equal highs/lows, external swings, and manual levels using base priority plus untouched/reaction/HTF/cluster bonuses and accepted/old/low-liquidity penalties. Nearby levels with similar scores are merged into one zone.
- Module 2 ranked liquidity also includes lower-priority internal swing high/low levels, applies minimum 3 bars between confirmed swings, uses 0.03 ATR structure tolerance, adds overlap bonus, and penalizes liquidity that is too close to opposing liquidity.
- Module 2 conflict resolution blocks simultaneous unresolved buy/sell setups; a confirmed MSS retest with entry confirmation can override weaker opposite sweep evidence.
- Module 2 final contract on VPS must be backed by migration `063_module2_complete_entry_contract.sql` plus later Module 2 variant migrations. The validator fails if registry/schema/production gates are missing.
- Migration `064_module2_swing_contract_backfill.sql` backfills the final swing contract fields for databases that already applied migration `063`.
- Module 2 platform-core engine contract is implemented from `TRADING PLATFORM CORE ENGINES NEXT UPDATE FOR THE LIQUIDITY SWEEP EXECUTION MODULE`.
- Module 2 now emits `scenarioFlags.platformEngines`, `sessionContext`, `structureGraph`, `liquidityLifecycle`, and richer `marketRegime` evidence from the strategy brain.
- Module 2 liquidity lifecycle states are `DETECTED`, `ACTIVE`, `APPROACHING`, `TOUCHED`, `PARTIALLY_SWEPT`, `SWEPT`, `RECLAIMED`, `ACCEPTED_BEYOND`, `CONSUMED`, `BROKEN`, `EXPIRED`, `MERGED`, and `RETIRED`.
- Module 2 structure graph evidence includes internal/external direction, alignment state, conflict mode, recent structure points with parent/previous references, and recent break events.
- Module 2 regime output is descriptive only, not predictive: primary regime, secondary regimes, confidence, actual values, and explanations. It must not create trades by itself.
- Module 2 platform-core persistence is backed by migration `065_module2_platform_core_engines.sql`, which adds liquidity lifecycle, structure, market regime, domain event, replay, analytics, checkpoint, plugin, parameter-version, manual-position, manual-execution reconciliation, journal-insight, experiment, and approval tables.
- Module 2 APIs now include tenant-scoped core-engine endpoints for liquidity active/history/detail/retire, structure current/history/breaks, market-regime current/history, manual positions current/history/open/update/close, replay shells, and parameter experiments.
- Module 2 live setup persistence now writes the platform-core evidence path whenever a setup decision is saved: event-processing log, liquidity level lifecycle rows/events, structure points/break events, market regime snapshots, domain event, system checkpoint, and audit log.
- Module 2 automatic paper entries now create a `positions` row plus `position_events` and a `TRADE_OPENED` checkpoint. When the paper trade reaches TP/SL, the linked position is closed with `CLOSED_WIN`, `CLOSED_LOSS`, or `CLOSED_BREAKEVEN`, a `TRADE_CLOSED` position event, and a closing checkpoint.
- Module 2 backtests now also write `backtest_events` for simulated trades so replay/backtest review has an event trace, not only final `backtest_trades` rows.
- Module 2 live setup endpoint `/api/setups/current?moduleCode=high_probability_strategy_2&evidence=true` now returns `coreEvidence` with liquidity levels/events, structure points/breaks, market regimes, domain events, checkpoints, transitions, and positions for the selected setup.
- Module 2 live chart side panel now displays engine output state, selected profile, market regime, top liquidity, structure break, linked position state, latest checkpoint, variant matrix, and persisted state-flow transitions.
- Current Module 2 full-path verification passed locally: `npm run typecheck -w @orb-guide/api`, `npm run verify:modules`, and `npm run validate:module2-production -- .env.production`. The production validator returned WARN only for missing fresh entry-ready/prediction/backtest-trade evidence in the local sample window, not schema or logic failures.
- Module 2 production proof endpoint is `/api/module2/production-proof/run`. It requires a subscriber with Module 2 enabled and creates a strict `SWEEP_MSS_RETEST` replay setup, opens a paper trade, writes journal evidence, stores a detailed notification payload, creates a learning-review artifact, and runs the Python main brain in proof mode.
- Module 2 production proof endpoint response now explicitly includes `journal` and requires `journalCreated` in its final PASS checks. A valid proof must confirm setup, strict variant, entry readiness, paper trade, journal, notification payload, and Python brain.
- Module 2 Predictions and BUY & SELL APIs continue to hide replay/proof rows in normal tenant mode. For production QA only, `/api/setups/predictions?moduleCode=high_probability_strategy_2&includeProof=true` and `/api/setups/signals?moduleCode=high_probability_strategy_2&includeProof=true` expose proof rows through the same UI mapping code. Predictions now return `takeProfit` alongside TP1/TP2/TP3.
- Module 2 live Predictions must be upcoming/recent only: normal prediction rows hide replay/proof rows, hide active paper trades, require at least 80% probability, require detection within 90 minutes of the latest 5M candle, and require entry to be close to current price. This prevents stale predictions such as current price 4260 with an old 4045 entry.
- Module 2 BUY & SELL cards are the main MVP output, not a paper-trade mirror. Normal mode shows recent near-current valid BUY/SELL setups with entry, SL, TP, chance, and module/variant evidence whether or not the audit paper-trade row has already opened. Paper trading mirrors those signals for win-rate/reporting only.
- Python main brain now ignores stale non-proof setup rows unless there is an active paper trade to manage, so Module 1 and Module 2 brain decisions stay aligned with current market context.
- Module 2 Python main brain supports `--proof-mode`. Live mode still excludes replay rows; proof mode intentionally reads only `scenario_flags.productionProof=true` replay evidence so the proof does not contaminate real live setup logic.
- Module 2 replay QA has been realigned to the final strategy: A-I can prove/open paper-entry behavior when their own mandatory profile and risk gates pass; J remains observable research/control only.
- Module 2 cache backtest endpoint now accepts `limit` and defaults Module 2 to a bounded latest-candle window to avoid blocking the API while validating locally or on VPS. Full historical runs should move to worker/job execution if they become heavy.
- Latest local proof on 2026-08-06: `POST /api/module2/production-proof/run` returned PASS with setup, strict variant, paper trade, notification payload, and Python brain all true. A bounded 300-candle Module 2 cache backtest completed with 0 full trades and 12 missed-trade learning reviews. `npm run validate:module2-production -- .env.production` returned 13 PASS, 3 WARN, 0 FAIL.
- Module 2 live chart now includes a Live Candidate Monitor panel. It reads current price/latest candle from `/api/setups/current?moduleCode=high_probability_strategy_2&evidence=true`, shows whether the setup is an 80%+ recent prediction, whether BUY/SELL has become an active paper trade, entry distance, age, and the first blocking rule explaining why no trade is available yet.
- Module 1 ORB chart levels must be rendered as timed session overlays, not full-width price lines. Each displayed session range starts at its own `session_start_at` so tenants can visually identify where the session ORB began.
- Module 1 production proof is covered by module verification: three 5M candles lock the 15M ORB range, the next completed 5M breakout candle must produce entry/SL/TP, and the Python Module 1 brain must approve BUY/SELL only when the mandatory ORB checklist is valid.
- Module 1 production proof endpoint is `/api/module1/production-proof/run`. It creates a proof-only ORB replay setup, active paper trade, journal, structured notification payload, and runs the Python Module 1 brain in proof mode. Normal tenant Predictions/BUY & SELL continue to hide proof rows unless `includeProof=true`.
- Module 1 sweep-reversal entries must not be blocked by the normal direct-breakout no-chase rule when the sequence is valid: opposite ORB boundary swept, candle closes back inside, then a completed candle closes beyond the other ORB boundary. Ordinary overextended breakouts still wait for retest, but confirmed sweep reversals can use a wider reversal extension limit and stop beyond the failed sweep.
- Module 1 must not become overly restrictive. Valid MVP-capable paths include opening-drive clean breakout, displacement clean breakout, trend-aligned clean breakout, breakout retest confirmation, sweep-retest continuation, liquidity-sweep reversal, mandatory-only ORB breakout, and active NY horizontal range breakout/retest. Observation/watch paths such as fakeout candidate, inside-range wait, double-sided sweep, and overextended no-chase should not open paper trades until their own confirmation path completes.
- Combined tenant proof validation command is `npm run validate:modules-flow`. It requires `TENANT_EMAIL`, `TENANT_PASSWORD`, optional `TENANT_OTP`, and optional `API_BASE_URL`; it runs Module 1 proof, Module 2 proof, then checks proof Predictions, BUY & SELL cards, Paper Trading rows, Notifications payloads, and dashboard bundles.
- Broker execution remains out of scope. Manual execution reconciliation is allowed only to compare a tenant's manual trade with the generated plan.
- Module 3 was intentionally removed completely; do not reintroduce it.
- Superseding runtime update, 2026-08-11: Module 2 keeps its independent variant matrix but evaluates live signals only during the New York session using completed shared XAUUSD 5M candles and 15M context.
- Module 2 variants are independent confirmation profiles evaluated after base conditions pass. The system must not require every variant to pass. One signal-approved variant plus hard risk approval can generate BUY/SELL, notifications, chart markers, and paper-trade tracking. The 80% confidence threshold controls upcoming Prediction publication only and must not veto an otherwise valid variant signal.
- Module 2 signal-approved profiles include A sweep close-back, B sweep + BOS, C sweep + MSS, D sweep + engulfing, E sweep + BOS + retest, F sweep + MSS + retest, G sweep + EMA alignment, H sweep + volume expansion, and I sweep + MSS + displacement + retest. J sweep + no-confirmation remains research/control only.
- Module 2 proof endpoint `/api/module2/variant-matrix-proof/run` validates the full A-J matrix without Twelve Data credits or broker orders. A-I must create setup evidence and paper-proof artifacts; J must remain blocked from paper trade creation.
- Combined tenant proof validation `npm run validate:modules-flow` now also runs the Module 2 A-J matrix proof and reports profile, variant code, paper-trade expectation, trade id, and notification id.
- Module 2 retest expiration only invalidates retest-based profiles. It must not kill simpler independent profiles that already passed their own mandatory rules.
- Module 2 Python brain must approve the selected signal-approved variant profile, not force every setup through strict MSS + retest. Protected point, BOS/CHoCH, MSS strength, entry zone, retrace, and entry candle are variant evidence unless the selected variant requires them.
- Module 2 Strategy Center should display base mandatory gates, selected variant profile, confirmation checklist, quality filters, and final automation gate. It should never display variants as one impossible combined checklist.
- Module 1 and Module 2 are New York-only strategy runtimes. Module 1 shows New York ORB High/Mid/Low and active horizontal-range evidence. Module 2 shows liquidity, sweep, displacement, BOS/MSS, FVG/order-block/retest zone, entry, stop, and target evidence. Their strategy state, indicators, checklists, signals, predictions, and trades remain isolated.
- Module 1 now has a generic range-engine foundation around the existing MAX Options ORB logic. ORB remains the authoritative detector and keeps the existing 15M opening range / 5M trigger behavior. The shared normalized range contract is stored in setup `scenario_flags.genericRangeEngine` and `scenario_flags.tradingRange`.
- Module 1 horizontal range breakout is a New York-session active signal detector (`rangeEngine.horizontalRange.enabled=true`, `scope=NEW_YORK_SESSION_ONLY`, `observationOnly=false`). It can trigger the MVP chain when `HORIZONTAL_RANGE_LOCKED`, `HORIZONTAL_BREAKOUT_CONFIRMED`, `HORIZONTAL_RETEST_CONFIRMED`, `HORIZONTAL_CONFLICT_CLEAR`, `ENTRY_NOT_OVEREXTENDED`, and `RISK_PERMISSION` pass. The normal ORB signal still takes priority when ready.
- Module 1 horizontal range detection must be strict enough for production: confirmed independent upper/lower reactions, opposite-half movement between repeated touches, close containment inside boundaries, no accepted breakout close during formation, low directional efficiency, flat reaction-point slope, ATR-normalized width, midpoint crosses, balanced time above/below midpoint, and minimum quality score. Horizontal breakout setups expire if retest does not occur within the configured candle limit.
- Module 1 range-engine API controls include active/history/detail/evidence/relationships, manual range invalidation, current/detail range setup views, confirm/skip/reject setup actions, manual detector pass, and tenant range-engine/chart setting read/update endpoints. WebSocket events now distinguish range locked/detected, breakout candidate/confirmed, false break, retest confirmed, setup ready, invalidated, and expired.
- Module 1 production proof endpoint now proves both MVP-capable Module 1 paths: classic ORB and NY horizontal range breakout/retest. The horizontal proof uses the real range detector, breakout evaluator, retest evaluator, conflict resolver, decision engine, paper-trade opener, journal, notification payload, and Python brain proof flow.
- Module 1 live chart now marks horizontal range locked, horizontal breakout, retest, and expired evidence. The horizontal box extends through the current chart view while active. Strategy Center explicitly shows the active Module 1 path plus the next missing entry rule for ORB or horizontal range.
- Module 1 horizontal range now emits the full range lifecycle event vocabulary for realtime consumers: `range.detected`, `range.candidate.updated`, `range.validated`, `range.locked`, `range.relationship.created`, `range.breakout.candidate`, `range.breakout.confirmed`, `range.false-breakout`, `range.retest.reached`, `range.retest.confirmed`, `range.setup.ready`, `range.setup.blocked`, `range.setup.expired`, and `range.setup.invalidated`.
- Module 1 rejected horizontal candidates must include `structureClassification` evidence such as `ASCENDING_CHANNEL`, `DESCENDING_CHANNEL`, `ASCENDING_TRIANGLE`, `DESCENDING_TRIANGLE`, `SYMMETRICAL_TRIANGLE`, or `UNKNOWN_NON_HORIZONTAL`, so the system can explain why a chart is not a valid horizontal consolidation.
- Module 1 horizontal range stop placement uses the retest swing plus ATR buffer. Expired retests must override overextended wait states so dead setups do not remain eligible.
- Module 1 and Module 2 strategy settings cards must stay readable in the tenant dashboard with responsive, full-width strategy fields and module-specific indicator toggles.
- Generic range architecture rule: range detectors may share lifecycle/breakout/retest/risk evidence, but ORB must never be forced to satisfy horizontal consolidation rules, and horizontal ranges must not inherit fixed NY/15M ORB assumptions.
- Paper Trading ledger rule: normal tenant paper-trade pages must exclude QA/proof/replay/rehearsal rows by default. Production validation can opt into proof rows with `includeProof=true`; tenant-facing history must show real automatic paper trades only.
- Python main-brain rule: Module 1 and Module 2 brains are the final signal automation gate after the TypeScript strategy engines create a setup. Module 1 approves ORB or NY horizontal range as independent paths. Module 2 approves the selected liquidity-sweep variant profile when core sweep evidence, safety/risk gates, entry/SL/TP, and direction are complete. Module 2 must not require every variant/global checklist item to pass before allowing a valid selected profile to trigger predictions, BUY/SELL, notifications, and the separate paper-trade audit path.
- Python brain contract is signal-first: `shouldEmitSignal` approves the MVP BUY/SELL output, `shouldTrackPaperTrade` approves the secondary win-rate tracking row, and legacy `shouldOpenPaperTrade` remains only for backward compatibility. API automation must gate user-facing signals on `shouldEmitSignal`, then create paper tracking only if the live entry guard and settings allow it.
- Current brain verification covers Module 1 ORB signal, Module 1 Horizontal Range signal, Module 2 full liquidity-sweep signal, Module 2 flexible variant signal, and negative legacy/incomplete checks through `python3 scripts/verify-python-brains.py` and `npm run verify:modules`.
- MVP signal philosophy: aim for practical opportunity coverage, roughly 1-2 high-quality opportunities in the New York session across Module 1/2 and 3-4 Module 2 opportunities across the full day when market structure supports it. Do not fake quota trades. Increase coverage by allowing independent valid profiles, separating hard safety blockers from optional confidence evidence, and showing clear wait/no-trade reasons.
- Product priority: Predictions and BUY/SELL signals are the main MVP. Paper trading is secondary evidence used to calculate win rate, R, journal/report statistics, and learning feedback. A valid signal should not disappear just because the paper-trade audit row is delayed, skipped by stale-price guard, or blocked by an existing active paper trade.
- Module 2 checklist separation: market/sweep/selected-variant/risk rules gate Predictions and BUY/SELL. Daily paper limits and active simulated-position conflicts belong to a separate Paper Tracking section and must never hide a valid signal. Aggregate confirmation and quality counts grade evidence rather than requiring every row.
- Module 2 paper tracking allows two distinct setups/positions per New York session by default so win-rate evidence can follow the product's two-signal coverage target; exact duplicate setup IDs remain rejected.
- Production replay reports an objective of at least two distinct quality setups per saved New York session. Module 1 counts separate transitions into signal-ready state and Module 2 counts unique swept-liquidity/profile episodes. Missing the objective is a tuning/backtest warning with no-trade evidence, never permission to fabricate a low-quality trade.
- Signal coverage audits count unique trade theses, not every candle that temporarily re-enters a ready state. Module 1 deduplicates by direction, strategy family, and opening range; Module 2 deduplicates by direction, selected profile, swept level, and sweep event.
- Module 2 confirmation profiles contain market-structure evidence only. The engine selects the strongest completed profile first, then applies hard trade geometry, RR, spread/news, and risk gates. Confidence score remains advisory evidence and controls the 80%+ Prediction surface. A risk-blocked profile cannot become a BUY/SELL signal.
- Module 1 favorability is also advisory evidence. It ranks setup confidence and prediction visibility but cannot veto a completed, non-overextended, risk-approved ORB or horizontal-range strategy profile.
- A Python-brain `WAIT` is a nonterminal monitoring state and must not cap an otherwise 80%+ upcoming Prediction. Only explicit brain safety rejection, invalidation, no-trade, checklist mismatch, or error states suppress prediction publication; final BUY/SELL promotion still requires exact setup-bound brain approval.
- Production Python-brain decisions are setup-bound. The worker must call the brain with the exact saved setup candidate ID, and brain approval must return that same setup ID, direction, and valid entry/SL/TP geometry. A decision about a different or merely latest setup can never approve or veto the candidate currently being promoted.
- Module 2 trade planning ranks only executable completed-candle plans: touched MSS/FVG/order-block structural invalidation first when risk-valid, with the original sweep extreme retained as the conservative fallback. The selected source and every candidate remain in `scenarioFlags.tradePlan` / `tradePlanCandidates` for audit and Python-brain review.
- Live MVP outputs deduplicate by underlying market thesis. Module 1 uses session + direction + scenario family; Module 2 uses session + direction + sweep event + liquidity level. Different Module 2 profiles confirming the same sweep are evidence for one signal, not multiple tenant alerts.
- Saved-candle validation scores each distinct setup forward to TP/SL using conservative same-candle ordering. Frequency alone cannot establish production quality: fewer than 60 resolved signals is an evidence warning, and a mature sample must remain positive in R with at least a 40% win rate at the fixed 2R target.
- Strategy Center UI must not present optional rows as one impossible all-pass checklist. Module 2 should show Base Safety Gates, Context Evidence, Selected Variant Profile, Confidence Evidence, Risk & Quality, and Final Automation Gate. BUY & SELL cards should say profile-approved rather than full-checklist unless literally every evidence row passed.
- Paper entry trust guard: automatic paper trades must not execute at a stale planned entry when the latest 5M candle has moved too far away. If live close is beyond the entry-distance guard, skip/mark the setup missed instead of opening a fake paper position. Paper ledger rows should expose historical price context when entry is far from current market.
- Module 2 trade geometry is a hard safety invariant, not a confidence score. A LONG requires `stop < entry < target`; a SHORT requires `target < entry < stop`. If price has crossed beyond the selected sweep invalidation extreme, the risk engine must block the setup even when a variant, score, and nominal absolute RR otherwise pass.
- MVP predeployment validation command is `npm run validate:mvp-predeploy -- .env.production`. It verifies TypeScript strategies, both Python brains, API/web types and production builds, active tenant risk profiles, saved 5M/15M candles, NY saved-candle opportunity replay, directional trade geometry, stale-price guards, and recent setup/notification/paper artifact linkage.
- Setup scores shown in Predictions and BUY/SELL are deterministic evidence/checklist scores out of 100, not calibrated probabilities of winning. Observed win rate and expectancy come only from resolved paper/backtest outcomes.
- Authentication sessions fail closed against PostgreSQL, rotate session identifiers during refresh/password/MFA changes, use HttpOnly cookies on web, and encrypt TOTP secrets at rest. Legacy plaintext TOTP secrets are re-encrypted after the next successful MFA login.
- Authenticated proof validation accepts either `TENANT_EMAIL` + `TENANT_PASSWORD` (+ optional `TENANT_OTP`) or an existing `TENANT_TOKEN`. It must be run separately with `npm run validate:modules-flow` to prove Predictions, BUY & SELL, notification details, paper tracking, journal evidence, and Module 2 A-J proof surfaces without exposing proof rows to normal tenant views.
- BUY & SELL target geometry is structural and risk-based, never a fixed 50/100/150-pip template. Entry comes from the module-approved setup or entry zone, SL remains beyond the strategy invalidation structure, TP1 is 1R, TP2 is 1.5R, and TP3 is the module-approved strategy target (normally 2R or better). Web, mobile, notifications, predictions, and mobile chart overlays must display the same ladder; paper tracking continues to score the approved final strategy target.
- Paper multi-target lifecycle is persisted in `paper_trade_targets` (migration `082`). The originating structural SL and initial risk distance are snapshotted on `trades` and cannot be replaced by a later setup refresh. TP1 and TP2 are progress milestones only; they append idempotent trade events, journal evidence, realtime events, and notifications while the simulated position remains active. TP3 is the module-approved final target and is the only target that closes the paper trade as a win. An SL touch records `PAPER_SL_HIT`, closes as a loss, and cancels pending milestones.
- A completed 5M candle that touches both SL and any pending TP has unknowable intrabar ordering, so paper tracking uses the conservative stop-first result. This prevents overstating win rate from candle ambiguity.
- The tenant web/mobile Paper Trading views and notification details must show the same persisted TP1/TP2/TP3 statuses. Initial BUY/SELL notifications carry all three targets. TP1/TP2 notifications are lifecycle updates, not fresh entry signals.
- Multi-target persistence is secondary to the signal-first MVP: Predictions and BUY & SELL are emitted from the approved Module 1/2 strategy thesis; paper milestones measure what happened afterward and must never manufacture, suppress, or duplicate the original signal.
- Production upgrades use `ADMIN_OTP='current-code' npm run deploy:vps-production -- .env.production`. The guarded rollout installs locked dependencies, validates production configuration, creates a PostgreSQL backup, rebuilds the migration image, applies checksum-ledger migrations, rebuilds/restarts services, proves BUY/SELL target sequences, audits migration `082` lifecycle integrity, verifies platform health, and requires a successful WebSocket HTTP 101 upgrade. A lack of genuine post-deployment TP/SL events is a monitoring warning; schema, geometry, duplicate-event, notification, and realized-R inconsistencies are deployment failures.
- Target performance analytics use the PostgreSQL view `paper_trade_target_performance` from migration `083`. Weekly and monthly reports calculate TP1/TP2/TP3 reach rates, TP1-to-TP2 and TP2-to-TP3 conversion, stop-after-progress rates, expectancy, profit factor, total R, and average holding time from persisted non-QA paper lifecycles.
- Target analytics break Module 1 down by scenario and Module 2 down by selected variant/profile. TP1 and TP2 remain progress evidence only; analytics never imply partial realized profit. Final realized R still comes from TP3, SL, or the recorded final exit against initial structural risk.
- Performance trust is sample-aware: fewer than 20 closed trades is `EARLY`, 20-49 is `RESEARCH`, and 50 or more is `MONITORABLE`. These labels describe evidence maturity and do not guarantee future win rate.
- Platform system health includes paper-lifecycle monitoring for active trades older than 12 hours, incomplete three-target ladders, and active trades carrying terminal TP3/SL milestones. These are operational cautions that require investigation.
- Production signal observation is persisted in `production_signal_observations` (migration `084`) and refreshed by the dedicated worker every five minutes. It audits genuine, non-QA Module 1/2 setup candidates through Prediction, BUY/SELL notification, optional paper tracking, TP1/TP2/TP3 persistence, journal evidence, and terminal lifecycle. Migration `085` adds the exact evidence lookup indexes, and each refresh enriches a bounded 100-candidate batch so a historical backfill cannot exceed the API statement timeout.
- Observation is signal-first: Prediction and BUY/SELL are primary MVP evidence. Paper tracking is expected only when the setup is paper-eligible; a delayed or disabled paper audit must not suppress a valid signal. Missing primary artifacts or broken target/journal lifecycles become deduplicated `MVP_SIGNAL_LIFECYCLE_FAILED` operational events after a 15-minute grace period.
- Observation evidence is sample-aware: fewer than 20 observed BUY/SELL signals is `EARLY`, 20-49 is `RESEARCH`, and 50+ is `MONITORABLE`. The system may compare modules/scenarios/variants at every stage, but threshold changes require reviewed evidence rather than automatic live mutation.
- Production observation is exposed to tenant web reports, mobile paper analytics, and platform system health. Validate it after migration with `npm run validate:production-observation -- .env.production`.
- The live chart is current-session-first. It may retain older candles for EMA/context and manual leftward panning, but the automatic viewport opens on the current New York trading date and only that date's setup, Module 1 ORB range, Module 2 evidence, and paper-trade markers may render as live artifacts. `/api/setups/current` and `/api/trades/chart-markers` enforce the same New York-date boundary server-side.
- On Docker/VPS deployments, run PostgreSQL-aware validators inside the API container. Its internal `DATABASE_URL` is authoritative and avoids host-port or special-character password mismatches.
- Live trade geometry is semantic: candidate FVG/order-block/ORB geometry may be rendered as module evidence, but chart lines named Entry, Structural SL, and TP1/TP2/TP3 render only after the setup reaches BUY/SELL readiness, trade planning, or paper tracking. The newest current-session candidate must drive live evidence instead of an older candidate being preferred merely because it contains more evidence keys.
- System Status and Strategy Center show the selected module's unified Setup -> Prediction -> BUY/SELL -> Paper mirror lifecycle. They load module-scoped signal and prediction data and state the first rule/reason preventing progression. Predictions and BUY/SELL remain primary MVP outputs; paper is explicitly displayed as a secondary performance mirror.
- Tenant dashboard responsibility boundaries: System Status diagnoses feed, scheduler, PostgreSQL, production readiness, and the current module signal lifecycle. Strategy Center explains the selected module's evidence, checklist/profile progression, current signal, and blocker. Reports measure Predictions and BUY/SELL delivery separately from paper target/outcome performance. Learning consumes module-specific signal observations, resolved paper/journal outcomes, and backtests to produce advisory recommendations; it never acts as the live signal engine or silently mutates production thresholds.
- Reports and Learning must load selected-module Predictions, BUY/SELL signals, production observations, confidence evidence, and target performance. Empty module reports must replace prior state rather than leaving another module's weekly/monthly rows visible after a module switch.
- Confirmed signal geometry is immutable for both modules. Five-minute evaluations may reprice a live prediction until promotion, but once BUY/SELL readiness creates a persisted trade plan, Entry, Structural SL, and TP1/TP2/TP3 must come from that plan; after paper tracking opens, the trade's `actual_*` snapshot has highest precedence. A later setup candidate must never move an existing signal contract on the chart or BUY & SELL page.
- Signal promotion persists an immutable `trade_plans` contract before notifications and independently of paper-tracking eligibility. `signal_thesis_key` is tenant-scoped and unique, so repeated five-minute confirmations of the same Module 1/2 market thesis reuse the original geometry. A genuinely different promoted thesis creates a new historical contract and becomes the current chart signal; `/api/trade-plans/history` exposes prior contracts for comparison.

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
# Historical validation foundation (2026-08-12)

- Migration `079_historical_strategy_validation.sql` isolates historical research candles from the seven-day live candle cache.
- `npm run validation:history` imports CSV/JSON, runs chronological Module 1/Module 2 replay, stores per-profile signals and metrics, and creates release-gate decisions.
- Module 2 variants are measured independently; module totals deduplicate variants representing the same sweep thesis.
- Release gates remain unenforced until the dataset contains at least 60 NY sessions and the profile has at least 30 resolved validation signals.
- Default release evidence requires positive expectancy/total R, profit factor >= 1.2, win rate >= 40%, and max drawdown <= 10R on the untouched validation partition.
- A six-session local smoke dataset completed the full import/replay/metrics/report chain and correctly produced only unenforced `INSUFFICIENT_DATA` gates.
- Operations guide: `docs/HISTORICAL_STRATEGY_VALIDATION.md`.
- Platform super admins review historical datasets, chronological runs, untouched validation metrics, and exact-profile release gates at `/platform-admin/validation`.
- Live release enforcement is profile-specific and fail-open: only `strategy_release_gates.enforced=true` can change live behavior. Enforced `BLOCKED` profiles remain auditable predictions but cannot emit BUY/SELL notifications or create paper-trade tracking rows. `__ALL__` module aggregate rows are reporting-only.
- `npm run validate:mvp-runtime -- .env.production` now checks the historical validation schema, rejects immature enforced gates, and detects any blocked profile that leaked into signal or paper-trade artifacts after gate evaluation.
