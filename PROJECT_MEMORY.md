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
- Paper trade opens only when module rules pass.

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
  - Risk validation.
  - Trade decision and automatic paper trade when setup-ready.
- Module 2 variant-driven production model:
  - Variant version is stored as `ULTIMATE_LIQUIDITY_SWEEP_V1.0`.
  - Current variant metadata is persisted in `setup_candidates.scenario_flags.module2Variant`, plus `variantCode` and `variantVersion`.
  - Variants are independent confirmation profiles evaluated after base liquidity sweep conditions.
  - Sweep-only/no-confirmation is research/control only and must not open automatic paper trades.
  - Paper-approved variants can open automatic paper trades when their own mandatory profile passes with risk approval, signal score, and Python brain approval.
  - `VARIANT_SELECTED` means one selected independent profile passed; it does not mean every variant must pass.
  - Required live base path: healthy data, active strategy cycle, valid ranked liquidity, sweep, close-back rejection, no acceptance, risk approval, signal score, and a selected paper-approved variant.
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

- Module 1 ORB is New York-session only again.
- Module 1 should evaluate only the `NEW_YORK_ORB` session for BUY/SELL signals, predictions, paper trades, journal rows, reports, and notifications.
- Module 1 keeps the existing MAX Options behavior: 15-minute New York opening range built from three 5-minute candles, then 5-minute closed-candle triggers.
- Module 1 horizontal range detection is active only during the New York ORB session and remains observation-only. It may persist range evidence and chart context, but it must not create paper trades, BUY/SELL cards, predictions, or change ORB entries.
- Module 2 remains the all-session Liquidity Sweep + MSS/Retest module and must not depend on Module 1 ORB sessions.
- All market sessions use the shared XAUUSD 5-minute Twelve Data candle feed. The platform requests one 5M candle sync per 5-minute cadence on market weekdays, then all modules evaluate from PostgreSQL.
- Sydney/Tokyo/London/New York ORB evaluation all use the same shared 5-minute candle cadence to protect the 800/day Twelve Data credit budget.
- Module 2 remains separate and now uses the Ultimate Liquidity Sweep + MSS + Retest production model, not the old `Liquidity Sweep + BOS` strategy.
- Module 2 profile evidence is registry-backed in `module2_strategy_variants` and versioned as `ULTIMATE_LIQUIDITY_SWEEP_V1.0`.
- Module 2 evidence profiles can be tracked for backtesting, but live paper trading is not a profile comparison system.
- Module 2 actionable live profiles are independent confirmation profiles. One paper-approved variant plus risk, score, and Python brain approval can generate a BUY/SELL signal and paper trade.
- Module 2 sweep-only/no-confirmation remains research/control only. Paper-approved profiles include sweep close-back, sweep engulfing, sweep BOS, sweep MSS, sweep volume expansion, displacement retest, EMA-aligned sweep, BOS retest, MSS retest, and MSS + displacement + retest.
- Module 2 paper trades require closed 5M candles, valid base sweep conditions, a selected paper-approved variant, risk guardrails, minimum confidence, and Python brain approval.
- Module 2 liquidity selection now includes previous week high/low, previous day high/low, Asian high/low, London high/low, NY premarket high/low, ORB high/low, equal high/low, swing high/low, round numbers, and optional manual levels.
- Module 2 confirmation layer currently tracks 10 plugins: 15M/EMA alignment, VWAP, fresh FVG, order-block retest, engulfing candle, pin-bar rejection, inside-bar break, doji rejection, volume expansion, and entry confirmation candle. Volume expansion remains record-only by default because XAUUSD provider volume may be incomplete.
- Module 2 tenant settings include EMA mode (`OFF`, `RECORD_ONLY`, `WARN_ONLY`, `REQUIRE_ALIGNMENT`, `REQUIRE_COUNTERTREND`) and volume mode (`OFF`, `RECORD_ONLY`, `WARN_ONLY`, `REQUIRE_EXPANSION`), plus NY premarket, ORB, round-number, and manual liquidity-level controls.
- Module 2 state transitions are persisted in `module2_state_transitions` so sweep, displacement, BOS/CHoCH, entry-zone, waiting-for-retest, retrace, entry-ready, invalidated, and expired evidence can be audited after the chart moves on.
- Module 2 manual liquidity levels are optional research inputs. Tenant settings sanitize and retain up to 20 manual levels with label, price, side, and priority. The engine treats them as potential liquidity zones only, never confirmed institutional liquidity.
- Module 2 per-variant live paper metrics are exposed through `/api/module2/variant-metrics` and snapshotted into `module2_variant_metric_snapshots`.
- Module 2 backtests may include profile/evidence analytics, but production live performance should be measured primarily against the strict `SWEEP_MSS_RETEST` profile.
- Module 2 missed-trade backtest evidence now includes variant, blocker, missing rule details, projected entry/SL/TP, projected outcome/result R, liquidity/sweep/displacement/structure/entry-zone snapshots, instruction text, and learning notes.
- Module 2 QA/replay must expose the real variant families: sweep-only research, sweep no-confirmation control, sweep+engulfing research, sweep+BOS research, sweep+MSS research, sweep+volume research, displacement retest, BOS retest, MSS retest, MSS+displacement+retest, and EMA-aligned sweep. Backtest UI should show missed setup instructions and evidence markers for swept liquidity, displacement, BOS/CHoCH, FVG/OB zone, and entry/SL/TP.
- Module 2 live evidence must stay aligned across live chart, Strategy Center, Predictions, BUY & SELL, web notifications, and mobile notification detail. These views should show variant, mandatory/confirmation/quality counts, missing blocking rules, liquidity, displacement, BOS/CHoCH, entry zone, and entry/SL/TP when available.
- Module 2 Predictions page only shows 80%+ candidates and now surfaces selected variant name/code/status, variant waiting rules, liquidity/sweep/displacement/BOS/entry-zone evidence, HTF bias, confirmation count, and quality count.
- Module 2 variant metrics table now includes live paper trades, win rate, average R, profit factor, max drawdown R, top blocker, blocker count, and recommendation.
- Module 2 backtests should create missed-trade learning review items. Reviews must preserve variant, blocker, missing rules, projected entry/SL/TP, projected TP/SL outcome, classification, guardrails, and proposed QA-only/observe-only next action.
- Module 2 production validation command is `npm run validate:module2-production -- .env.production`. It checks PostgreSQL 5M candles, Module 2 catalog/tenant assignment, latest cache backtest, 80%+ predictions, entry-ready setup chain, paper trade, notification payload, journal, and learning review evidence.
- Latest Module 2 final contract implemented from `LIQUIDITY SWEEP + MSS + RETEST COMPLETE VALID TRADE ENTRY ENGINE FOR SOFTWARE`.
- Module 2 engine path is now: market data -> data health -> session -> market context -> market regime -> swing detection -> liquidity detection/ranking -> sweep -> rejection/acceptance -> protected structure -> reversal MSS -> retest -> context filters -> conflict resolution -> risk -> confidence -> BUY_READY/SELL_READY/WAIT/BLOCK/INVALIDATE/EXPIRE.
- Module 2 data health states are `HEALTHY`, `DELAYED`, `STALE`, `DISCONNECTED`, `INCONSISTENT`, and `RATE_LIMITED`. Non-healthy data blocks live paper-entry decisions.
- Module 2 base mandatory gates now include data health, market context, market regime, active strategy cycle, daily trade limit, active setup conflict, active paper trade conflict, daily/weekly/consecutive-loss risk limits, manual-confirmation mode, ranked liquidity level, sweep, close-back rejection, no acceptance, risk engine, signal score, and selected variant. Variant-specific requirements such as BOS, MSS, protected point, retest, displacement, EMA, engulfing, or entry candle belong to the selected independent profile.
- Module 2 displacement is context by default (`WARN_ONLY`), not mandatory unless `displacementFilterMode` is set to `REQUIRED`.
- Module 2 EMA defaults to `WARN_ONLY`; volume defaults to `RECORD_ONLY`; market context defaults to `RECORD_ONLY`; manual confirmation defaults to `false` for automatic paper trading.
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
- Module 2 BUY & SELL cards are stricter than Predictions: normal mode now requires an actual active paper trade row. A valid signal card means the module met production rules, created the paper trade, and can show entry/SL/TP details.
- Python main brain now ignores stale non-proof setup rows unless there is an active paper trade to manage, so Module 1 and Module 2 brain decisions stay aligned with current market context.
- Module 2 Python main brain supports `--proof-mode`. Live mode still excludes replay rows; proof mode intentionally reads only `scenario_flags.productionProof=true` replay evidence so the proof does not contaminate real live setup logic.
- Module 2 replay QA has been realigned to the final strategy: research/control profiles remain observable, while paper-approved independent variants can prove/open paper-entry behavior when their own mandatory profile and risk gates pass.
- Module 2 cache backtest endpoint now accepts `limit` and defaults Module 2 to a bounded latest-candle window to avoid blocking the API while validating locally or on VPS. Full historical runs should move to worker/job execution if they become heavy.
- Latest local proof on 2026-08-06: `POST /api/module2/production-proof/run` returned PASS with setup, strict variant, paper trade, notification payload, and Python brain all true. A bounded 300-candle Module 2 cache backtest completed with 0 full trades and 12 missed-trade learning reviews. `npm run validate:module2-production -- .env.production` returned 13 PASS, 3 WARN, 0 FAIL.
- Module 2 live chart now includes a Live Candidate Monitor panel. It reads current price/latest candle from `/api/setups/current?moduleCode=high_probability_strategy_2&evidence=true`, shows whether the setup is an 80%+ recent prediction, whether BUY/SELL has become an active paper trade, entry distance, age, and the first blocking rule explaining why no trade is available yet.
- Module 1 ORB chart levels must be rendered as timed session overlays, not full-width price lines. Each displayed session range starts at its own `session_start_at` so tenants can visually identify where the session ORB began.
- Module 1 production proof is covered by module verification: three 5M candles lock the 15M ORB range, the next completed 5M breakout candle must produce entry/SL/TP, and the Python Module 1 brain must approve paper entry only when the mandatory ORB checklist is valid.
- Module 1 production proof endpoint is `/api/module1/production-proof/run`. It creates a proof-only ORB replay setup, active paper trade, journal, structured notification payload, and runs the Python Module 1 brain in proof mode. Normal tenant Predictions/BUY & SELL continue to hide proof rows unless `includeProof=true`.
- Combined tenant proof validation command is `npm run validate:modules-flow`. It requires `TENANT_EMAIL`, `TENANT_PASSWORD`, optional `TENANT_OTP`, and optional `API_BASE_URL`; it runs Module 1 proof, Module 2 proof, then checks proof Predictions, BUY & SELL cards, Paper Trading rows, Notifications payloads, and dashboard bundles.
- Broker execution remains out of scope. Manual execution reconciliation is allowed only to compare a tenant's manual trade with the generated plan.
- Module 3 was intentionally removed completely; do not reintroduce it.
- Superseding Module 2 architecture update, 2026-08-06: Module 2 is no longer New York-only and no longer strict-MSS-retest-only for production entry. It runs as an all-session liquidity sweep strategy cycle using the shared XAUUSD 5M candle feed.
- Module 2 variants are independent confirmation profiles evaluated after base conditions pass. The system must not require every variant to pass. One paper-approved variant plus risk and score gates can generate BUY/SELL, paper trade, journal, notification, chart markers, and predictions.
- Module 2 paper-approved profiles include sweep close-back, sweep engulfing, sweep BOS, sweep MSS, sweep volume expansion, displacement retest, EMA-aligned sweep, BOS retest, MSS retest, and MSS + displacement + retest. Sweep-only/no-confirmation remains research/control only.
- Module 2 retest expiration only invalidates retest-based profiles. It must not kill simpler independent profiles that already passed their own mandatory rules.
- Module 2 Strategy Center should display base mandatory gates, selected variant profile, confirmation checklist, quality filters, and final automation gate. It should never display variants as one impossible combined checklist.
- Module 1 is New York-only; Module 2 is all-session. Module 1 should show New York ORB High/Mid/Low indicators and NY-only horizontal range observations when evidence exists. Module 2 should show liquidity, sweep, displacement, BOS/MSS, FVG/order-block/retest zone, entry, stop, and target indicators when evidence exists.
- Module 1 now has a generic range-engine foundation around the existing MAX Options ORB logic. ORB remains the authoritative detector and keeps the existing 15M opening range / 5M trigger behavior. The shared normalized range contract is stored in setup `scenario_flags.genericRangeEngine` and `scenario_flags.tradingRange`.
- Module 1 horizontal range breakout is introduced only as a New York-session, observation-only detector (`rangeEngine.horizontalRange.enabled=true`, `scope=NEW_YORK_SESSION_ONLY`, `observationOnly=true`). It must not create paper trades, BUY/SELL cards, predictions, or change ORB entries until separate backtest/demo promotion gates are added and passed.
- Generic range architecture rule: range detectors may share lifecycle/breakout/retest/risk evidence, but ORB must never be forced to satisfy horizontal consolidation rules, and horizontal ranges must not inherit fixed NY/15M ORB assumptions.

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
