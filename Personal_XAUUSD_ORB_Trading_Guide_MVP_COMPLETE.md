# Personal XAUUSD New York ORB Trading Guide System

**Document type:** Build-ready MVP software specification  
**Primary user:** Single personal trader  
**Primary market:** XAUUSD  
**Primary session:** New York  
**Primary strategy family:** Max-inspired 15-minute Opening Range Breakout (ORB)  
**Cost target:** NPR 0 recurring software cost  
**Execution model:** Manual trade confirmation and manual broker execution  
**Deployment:** Local-first  
**Version:** 1.0.0

---

# 1. Purpose

This system is a personal trading guide, research platform, and discipline tool built around the New York Opening Range Breakout strategy.

It must help the user:

- prepare for the New York session;
- construct the opening range correctly;
- detect potential long and short setups;
- distinguish clean breakouts, retests, failures, reversals, midpoint reactions, and double-sided sweeps;
- calculate risk, stop-loss, take-profit, and position size;
- notify the user when a valid setup is forming;
- explain why a setup is valid, invalid, waiting, expired, or blocked;
- record every setup, whether traded or skipped;
- backtest strategy versions;
- compare scenarios and filters;
- improve the strategy using the user's own evidence.

The MVP must not promise profitable trades. It must provide deterministic, explainable instructions based on configured rules.

---

# 2. Non-Negotiable Product Principles

## 2.1 Free and local-first

The first version must use only free and open-source software.

Recommended stack:

- React
- TypeScript
- Vite
- Fastify or Express
- SQLite
- Python
- FastAPI
- Pandas
- NumPy
- Lightweight Charts
- Browser notifications
- Local file storage
- Docker Compose or direct local processes

No required:

- paid VPS;
- paid database;
- paid market-data API;
- paid news API;
- paid AI API;
- paid TradingView subscription;
- paid chart library;
- paid notification service.

## 2.2 Manual execution

The MVP may say:

- `LONG SETUP READY`
- `SHORT SETUP READY`
- `WAIT FOR RETEST`
- `NO TRADE`
- `SETUP EXPIRED`

The MVP must not automatically place broker orders.

## 2.3 Deterministic decisions

The core decision engine must use explicit rules.

AI may later explain results, but AI must not:

- invent prices;
- override risk limits;
- approve a trade independently;
- change strategy rules during a live session;
- calculate position size without deterministic validation.

## 2.4 Strategy versioning

No active strategy version may be edited after it has generated a signal or trade.

Required flow:

```text
Max-Inspired XAUUSD ORB v1.0
        ↓ clone
Max-Inspired XAUUSD ORB v1.1
```

Every setup and trade must reference the exact strategy version used.

## 2.5 Explainability

Every rule evaluation must show:

- rule name;
- pass/fail/waiting status;
- actual value;
- required value;
- explanation;
- whether it is blocking;
- whether it was automatic or manually confirmed.

---

# 3. Scope of the MVP

The MVP includes:

1. Local personal login or local PIN
2. XAUUSD instrument configuration
3. New York timezone clock
4. Session scheduler
5. Opening-range builder
6. ORB high, midpoint, and low
7. Max-inspired scenario engine
8. Long and short setup validation
9. Retest tracking
10. Failed-breakout reversal tracking
11. Midpoint context tracking
12. Double-sided sweep detection
13. No-trade classification
14. Risk calculator
15. Position-size calculator
16. Manual pre-trade checklist
17. Browser and desktop notifications
18. Manual trade plan
19. Manual trade journal
20. Screenshot attachments
21. Historical CSV importer
22. Basic backtesting
23. Performance dashboard
24. Strategy versioning
25. Local backup and export

The MVP excludes:

- automatic broker order execution;
- copy trading;
- social trading;
- multi-user accounts;
- cloud deployment;
- paid live data;
- premium Max indicator copying;
- paid economic-calendar integration;
- AI-generated trade decisions.

---

# 4. Strategy Source and Attribution

The initial strategy is inspired by publicly discussed ORB concepts associated with Max Options Trading.

Store the source as:

```json
{
  "strategyName": "Max-Inspired XAUUSD New York ORB",
  "sourceType": "PUBLIC_EDUCATIONAL_REFERENCE",
  "sourceCreator": "Max Options Trading",
  "implementationType": "USER_INTERPRETATION",
  "marketOriginallyObserved": "US market ORB concepts",
  "adaptedMarket": "XAUUSD",
  "distribution": "PERSONAL_USE_ONLY",
  "status": "RESEARCH"
}
```

The application must not claim to reproduce any paid or private proprietary strategy exactly.

The system must support adding future observations from:

- public videos;
- the user's own screenshots;
- the user's own rules;
- backtest findings;
- forward-test findings.

---

# 5. Primary Instrument: XAUUSD

XAUUSD is the first supported instrument.

## 5.1 Instrument metadata

```json
{
  "symbol": "XAUUSD",
  "displayName": "Gold vs US Dollar",
  "baseAsset": "XAU",
  "quoteCurrency": "USD",
  "priceDecimals": 2,
  "tickSize": 0.01,
  "contractSize": null,
  "pipDefinition": "BROKER_CONFIGURABLE",
  "minimumLot": null,
  "lotStep": null,
  "maximumLot": null
}
```

Broker specifications vary. The application must not assume one universal gold contract size.

The user must configure:

- contract size;
- minimum lot;
- lot step;
- maximum lot;
- tick size;
- tick value;
- account currency;
- commission model;
- typical spread.

## 5.2 XAUUSD-specific considerations

The system must account for:

- larger intraday volatility than many major forex pairs;
- widening spreads around news and session opens;
- strong reactions to USD news;
- strong reactions to interest-rate expectations;
- false breakouts around high-impact events;
- significant movement during the New York session;
- broker-specific quote precision.

The system must therefore support:

- maximum spread filter;
- maximum opening-range width;
- minimum opening-range width;
- maximum breakout extension;
- news blocking;
- lower default risk;
- one trade per session in MVP.

---

# 6. Timezone and Session Logic

## 6.1 Internal time

Store all timestamps in UTC.

Display:

- New York time using `America/New_York`;
- Nepal time using `Asia/Kathmandu`;
- optional broker-server time.

Do not manually hard-code UTC-4 or UTC-5.

## 6.2 Configurable New York session presets

The system must support multiple ORB presets:

### Preset A: 08:00 New York ORB

```text
Opening range: 08:00–08:15
Signal window: 08:15–11:00
```

### Preset B: 08:30 New York ORB

```text
Opening range: 08:30–08:45
Signal window: 08:45–11:00
```

### Preset C: 09:30 New York ORB

```text
Opening range: 09:30–09:45
Signal window: 09:45–11:30
```

For the first forward test, the user must select only one preset and keep it unchanged for the defined test block.

Recommended initial research preset:

```text
09:30 New York time
15-minute opening range
5-minute signal timeframe
```

This is configurable and not assumed to be profitable.

## 6.3 Session states

```text
SESSION_NOT_STARTED
PRE_SESSION
OPENING_RANGE_FORMING
OPENING_RANGE_LOCKED
WAITING_FOR_SETUP
BREAKOUT_CANDIDATE
WAITING_FOR_RETEST
REVERSAL_CANDIDATE
SETUP_READY
TRADE_PLANNED
TRADE_ACTIVE
TRADE_CLOSED
NO_TRADE
SESSION_EXPIRED
SESSION_COMPLETED
```

## 6.4 Valid transitions

```text
SESSION_NOT_STARTED
  → PRE_SESSION
  → OPENING_RANGE_FORMING
  → OPENING_RANGE_LOCKED
  → WAITING_FOR_SETUP
```

From `WAITING_FOR_SETUP`:

```text
→ BREAKOUT_CANDIDATE
→ REVERSAL_CANDIDATE
→ NO_TRADE
→ SESSION_EXPIRED
```

From `BREAKOUT_CANDIDATE`:

```text
→ SETUP_READY
→ WAITING_FOR_RETEST
→ WAITING_FOR_SETUP
→ NO_TRADE
→ SESSION_EXPIRED
```

---

# 7. Opening Range Engine

## 7.1 Required outputs

The opening-range engine calculates:

- ORB high;
- ORB low;
- ORB midpoint;
- ORB width in price units;
- ORB width in ticks;
- ORB width as a percentage of ATR;
- opening-range start and end timestamps;
- source candle count;
- data-quality status.

## 7.2 Calculation

```text
ORB High = maximum candle high during opening range
ORB Low = minimum candle low during opening range
ORB Midpoint = (ORB High + ORB Low) / 2
ORB Width = ORB High - ORB Low
```

## 7.3 Locking behavior

The range remains `FORMING` until the configured end time.

After completion:

```text
status = LOCKED
```

Once locked, the range cannot change.

If data is missing:

```text
status = INVALID
reason = MISSING_CANDLES
```

## 7.4 Data-quality validation

Reject range construction when:

- candles are missing;
- timestamps overlap;
- duplicate candles exist;
- candle high is below candle low;
- high is below open or close;
- low is above open or close;
- timezone cannot be determined;
- session contains insufficient candles.

---

# 8. Max-Inspired ORB Scenario Engine

The MVP must support these independent scenarios.

1. Clean breakout continuation
2. Breakout and retest
3. Failed breakout reversal
4. Midpoint reaction
5. Double-sided sweep
6. Choppy no-trade session
7. Late breakout
8. Overextended breakout
9. News-contaminated setup
10. Invalid range session

Each scenario must be reported separately.

---

# 9. Scenario A: Clean Breakout Continuation

## 9.1 Long setup

A potential long breakout begins when price trades above the ORB high.

It becomes confirmed when:

1. opening range is locked;
2. current time is inside the allowed signal window;
3. a completed signal candle closes above the ORB high;
4. breakout is not wick-only;
5. breakout candle quality passes;
6. spread passes;
7. range width passes;
8. entry is not too extended;
9. risk engine permits the trade;
10. reward-to-risk is acceptable;
11. no blocking news condition exists;
12. maximum trade count is not reached.

## 9.2 Short setup

Mirror logic:

1. candle closes below ORB low;
2. all filters and risk rules pass.

## 9.3 Breakout candle quality

Calculate:

```text
body = absolute(close - open)
fullRange = high - low
bodyRatio = body / fullRange
```

Long close-location ratio:

```text
(close - low) / (high - low)
```

Short close-location ratio:

```text
(high - close) / (high - low)
```

Configurable conditions:

- minimum body ratio;
- minimum close-location ratio;
- maximum opposite wick ratio;
- minimum breakout distance;
- maximum breakout extension.

Initial MVP defaults should be marked experimental:

```json
{
  "minimumBodyRatio": 0.55,
  "minimumCloseLocationRatio": 0.65,
  "maximumOppositeWickRatio": 0.30,
  "status": "EXPERIMENTAL"
}
```

These values must remain configurable.

## 9.4 Long instruction

When all mandatory conditions pass:

```text
LONG SETUP READY

Reason:
A completed candle closed above the ORB high with acceptable candle
strength, spread, range width, timing, risk, and reward-to-risk.

Instruction:
Wait for manual confirmation. Do not enter if the current price has
moved beyond the maximum allowed entry extension.
```

## 9.5 Short instruction

```text
SHORT SETUP READY

Reason:
A completed candle closed below the ORB low with acceptable candle
strength, spread, range width, timing, risk, and reward-to-risk.
```

---

# 10. Scenario B: Breakout and Retest

## 10.1 Long retest flow

```text
Candle closes above ORB High
        ↓
BREAKOUT_CONFIRMED
        ↓
WAITING_FOR_RETEST
        ↓
Price returns to retest zone
        ↓
LEVEL_RETESTED
        ↓
Bullish confirmation forms
        ↓
LONG SETUP READY
```

## 10.2 Short retest flow

Mirror logic around ORB low.

## 10.3 Retest zone

Use configurable tolerance:

```text
Retest lower boundary = ORB High - penetration tolerance
Retest upper boundary = ORB High + proximity tolerance
```

For short:

```text
Retest lower boundary = ORB Low - proximity tolerance
Retest upper boundary = ORB Low + penetration tolerance
```

Tolerance may be defined by:

- fixed price units;
- ticks;
- percentage of ORB width;
- ATR fraction.

Recommended MVP method:

```text
percentage of ORB width
```

Example experimental configuration:

```json
{
  "retestZonePercentOfRange": 0.10,
  "maximumRetestCandles": 6,
  "confirmationRequired": true
}
```

## 10.4 Retest confirmations

Possible confirmations:

- bullish candle closes above ORB high;
- bearish candle closes below ORB low;
- rejection wick at level;
- engulfing candle;
- micro structure break;
- manual confirmation.

MVP should automate only objective candle-close logic and leave structure interpretation as manual.

## 10.5 Retest expiration

Retest expires when:

- maximum retest candles exceeded;
- trade window expired;
- price crosses too deeply back into range;
- opposite ORB boundary is reached;
- news block becomes active;
- risk limit reached.

---

# 11. Scenario C: Failed Breakout Reversal

## 11.1 Failed bullish breakout

A failed bullish breakout is detected when:

1. price traded above ORB high;
2. breakout did not maintain acceptance;
3. a completed candle closes back inside the range.

This creates a reversal candidate, not an immediate short.

Short reversal becomes ready only when configured confirmation passes.

Possible confirmation:

- candle closes below midpoint;
- bearish rejection at ORB high;
- lower high followed by bearish close;
- manual structure confirmation.

## 11.2 Failed bearish breakout

Mirror logic:

1. price trades below ORB low;
2. candle closes back inside;
3. bullish confirmation required;
4. optional midpoint reclaim.

## 11.3 Reversal state machine

```text
EXTERNAL_BREAK
FAILED_ACCEPTANCE
CLOSE_BACK_INSIDE
WAITING_FOR_REVERSAL_CONFIRMATION
REVERSAL_READY
REVERSAL_INVALIDATED
```

## 11.4 Default safety

For MVP:

```text
Failed-breakout reversal = observation and alert mode
Manual confirmation required
No automatic readiness unless all configured rules pass
```

---

# 12. Scenario D: Midpoint Reaction

Track:

- current side of midpoint;
- number of midpoint crosses;
- time spent above midpoint;
- time spent below midpoint;
- midpoint hold after retest;
- midpoint rejection;
- midpoint reclaim.

## 12.1 Context interpretation

```text
Price holds above midpoint:
Bullish intrarange control

Price holds below midpoint:
Bearish intrarange control

Frequent midpoint crossings:
Choppy or indecisive session
```

## 12.2 MVP behavior

Midpoint should be:

- displayed;
- recorded;
- used in failed-breakout confirmation;
- used in chop detection;
- configurable as a filter.

Initially:

```text
midpoint bias = RECORD_ONLY
```

---

# 13. Scenario E: Double-Sided Sweep

Double-sided sweep occurs when:

- price breaks or sweeps ORB high;
- later breaks or sweeps ORB low;
- or the reverse sequence occurs.

## 13.1 Default system action

```text
SESSION CLASSIFICATION: DOUBLE-SIDED SWEEP
CONTINUATION TRADES: BLOCKED
REVERSAL TRADES: MANUAL REVIEW ONLY
```

## 13.2 Stored details

- first side swept;
- first sweep time;
- second side swept;
- second sweep time;
- whether closes occurred outside;
- whether moves were wick-only;
- news context;
- spread;
- eventual session direction.

---

# 14. Scenario F: Choppy No-Trade Session

Classify a session as choppy when configurable conditions occur.

Possible signals:

- midpoint crossed at least N times;
- both sides repeatedly probed;
- no candle maintains acceptance outside range;
- opening range too narrow;
- spread too large relative to range;
- alternating candle direction;
- signal window nearly expired.

Initial experimental condition:

```json
{
  "maximumMidpointCrosses": 5,
  "blockAfterDoubleSidedBreak": true,
  "minimumAcceptanceCandles": 1
}
```

Output:

```text
NO TRADE

Reason:
Price repeatedly crossed the ORB midpoint and failed to maintain
acceptance outside either boundary.
```

---

# 15. Range Filters

## 15.1 Minimum range

Reject or warn when the range is too narrow.

Supported methods:

- fixed XAUUSD price width;
- ticks;
- percentage of ATR;
- percentile compared with recent sessions.

## 15.2 Maximum range

Reject or warn when the range is too wide.

A wide range may create:

- oversized stop;
- poor reward-to-risk;
- late entry;
- reduced target space.

## 15.3 MVP behavior

Because the user has not completed research, range limits must support three modes:

```text
OFF
WARN_ONLY
BLOCK
```

Initial:

```text
WARN_ONLY
```

The system should collect results before converting range width into a hard filter.

---

# 16. Trend and Context Filters

All context filters must be independently configurable.

## 16.1 Higher-timeframe trend

Possible:

- price above/below EMA 200;
- EMA 20 vs EMA 50;
- 15-minute market structure;
- 1-hour market structure;
- previous-day direction.

Initial MVP:

```text
calculate and record
do not block
```

## 16.2 Previous-day levels

Store:

- previous-day high;
- previous-day low;
- previous-day close;
- previous-day midpoint.

Warn if the projected target immediately collides with one of these levels.

## 16.3 Session high/low context

Optional future fields:

- Asian session high/low;
- London session high/low;
- New York pre-market high/low.

For MVP, these may be manually entered or derived from imported data.

---

# 17. News Filter

Because the system must remain free, MVP news handling is manual.

## 17.1 Manual event entry

Fields:

- event title;
- affected currency;
- date;
- New York time;
- impact;
- block minutes before;
- block minutes after;
- notes.

Example:

```json
{
  "title": "US Non-Farm Payrolls",
  "currency": "USD",
  "impact": "HIGH",
  "eventTime": "08:30",
  "blockBeforeMinutes": 30,
  "blockAfterMinutes": 30
}
```

## 17.2 XAUUSD relevance

Events affecting USD should be considered relevant to XAUUSD.

## 17.3 News status

```text
CLEAR
UPCOMING_WARNING
BLOCKED_BEFORE_EVENT
BLOCKED_AFTER_EVENT
MANUAL_OVERRIDE
```

Manual override must require a reason.

---

# 18. Spread and Market-Quality Filter

The user must manually enter or import current spread in MVP.

## 18.1 Checks

- maximum absolute spread;
- spread as percentage of planned stop;
- spread as percentage of ORB width;
- spread spike compared with recent average.

## 18.2 Suggested rule

```text
Spread must be less than or equal to configured percentage of stop distance.
```

Example:

```json
{
  "maximumSpreadPercentOfStop": 10,
  "mode": "BLOCK"
}
```

---

# 19. Entry Models

The strategy engine must support:

## 19.1 Breakout close entry

Entry at or near the completed breakout candle close.

## 19.2 Retest confirmation entry

Entry after the retest confirmation candle closes.

## 19.3 Manual exact entry

The user enters broker price manually.

## 19.4 Stop-order model

Future feature only. Do not implement broker execution in MVP.

---

# 20. Stop-Loss Models

Support independent calculators.

## 20.1 Opposite ORB boundary

Long:

```text
stop = ORB low - buffer
```

Short:

```text
stop = ORB high + buffer
```

## 20.2 Breakout candle

Long:

```text
stop = breakout candle low - buffer
```

Short:

```text
stop = breakout candle high + buffer
```

## 20.3 Retest swing

Long:

```text
stop = retest swing low - buffer
```

Short:

```text
stop = retest swing high + buffer
```

## 20.4 Range boundary

Long:

```text
stop below ORB high
```

Short:

```text
stop above ORB low
```

This tighter model must be separately backtested.

## 20.5 ATR model

```text
stop distance = ATR × multiplier
```

---

# 21. Take-Profit Models

Support:

1. Fixed R multiple
2. ORB range projection
3. Previous-day level
4. Partial exit
5. Trailing stop
6. Time-based exit
7. Manual target

## 21.1 Fixed R

Initial MVP default:

```text
target = 2R
```

Configurable:

- 1R
- 1.5R
- 2R
- 2.5R
- 3R

## 21.2 ORB projection

Long:

```text
target = ORB high + ORB width
```

Short:

```text
target = ORB low - ORB width
```

## 21.3 Target validation

The trade is blocked or warned when:

- reward-to-risk below configured minimum;
- target collides with nearby major level;
- signal is too late;
- remaining session window is too short.

---

# 22. Risk Engine

The risk engine must run independently from the setup engine.

A chart setup can pass while risk permission fails.

## 22.1 Inputs

- account balance;
- account equity;
- account currency;
- risk percentage;
- entry;
- stop;
- target;
- instrument contract size;
- tick size;
- tick value;
- minimum lot;
- lot step;
- maximum lot;
- spread;
- commission;
- existing daily result;
- existing weekly result;
- current open risk.

## 22.2 Outputs

- planned risk amount;
- stop distance;
- suggested lot size;
- estimated spread cost;
- estimated commission;
- target reward;
- reward-to-risk;
- maximum possible loss;
- permission result;
- blocking reasons.

## 22.3 Initial conservative defaults

```json
{
  "riskPerTradePercent": 0.25,
  "maximumDailyLossPercent": 0.75,
  "maximumWeeklyLossPercent": 2.0,
  "maximumTradesPerSession": 1,
  "maximumConsecutiveLosses": 3,
  "mandatoryStopLoss": true,
  "allowMartingale": false,
  "allowAddingToLoss": false,
  "allowMovingStopFarther": false
}
```

All defaults must be editable.

## 22.4 Risk permission states

```text
PERMITTED
WARNING
BLOCKED
```

Example:

```json
{
  "status": "BLOCKED",
  "reasons": [
    "Daily loss limit has been reached.",
    "Calculated lot size is below broker minimum.",
    "Reward-to-risk is below 1.5."
  ]
}
```

---

# 23. Trade Decision Engine

The final decision is derived from:

```text
Session State
+ ORB Scenario
+ Rule Results
+ News Status
+ Spread Status
+ Risk Permission
+ Manual Checklist
= Trade Guidance
```

## 23.1 Possible outputs

```text
PREPARE
WAIT
POTENTIAL LONG
POTENTIAL SHORT
WAIT FOR RETEST
LONG SETUP READY
SHORT SETUP READY
REVERSAL CANDIDATE
NO TRADE
BLOCKED
EXPIRED
TRADE ACTIVE
```

## 23.2 Mandatory wording

Never show:

```text
Guaranteed Buy
Guaranteed Sell
Sure Profit
100% Setup
```

Use:

```text
LONG SETUP READY
SHORT SETUP READY
CONDITIONS MATCHED
MANUAL CONFIRMATION REQUIRED
```

---

# 24. Pre-Trade Checklist

## 24.1 Long checklist

```text
[ ] ORB is complete and locked
[ ] Current time is inside allowed window
[ ] Candle closed above ORB high
[ ] Breakout is not wick-only
[ ] Candle quality passed
[ ] Range width is acceptable
[ ] Entry is not overextended
[ ] Spread is acceptable
[ ] No blocked USD news
[ ] Daily loss limit not reached
[ ] Maximum trade count not reached
[ ] Stop-loss is defined
[ ] Position size is valid
[ ] Reward-to-risk meets minimum
[ ] User is not revenge trading
[ ] User manually confirms trade
```

## 24.2 Short checklist

Mirror logic below ORB low.

## 24.3 Manual answers

Each answer:

```text
YES
NO
UNCERTAIN
NOT_APPLICABLE
```

Any mandatory `NO` blocks the trade.

Any mandatory `UNCERTAIN` keeps the setup in `WAIT`.

---

# 25. Notifications

Use only free local notifications.

## 25.1 Channels

- browser notification;
- desktop notification;
- sound alert;
- optional local email later.

## 25.2 Notification events

### Pre-session

```text
New York ORB session begins in 30 minutes.
Review news, account risk, and strategy version.
```

### Range forming

```text
Opening range is forming. Do not trade yet.
```

### Range locked

```text
XAUUSD ORB locked.
High: {high}
Midpoint: {mid}
Low: {low}
Width: {width}
```

### Breakout candidate

```text
Potential XAUUSD LONG breakout detected.
Waiting for candle close confirmation.
```

### Retest

```text
Long breakout confirmed.
Price has entered the ORB-high retest zone.
```

### Ready

```text
XAUUSD LONG SETUP READY.
All automatic conditions passed.
Manual confirmation is required.
```

### Blocked

```text
Trade blocked.
Reason: High-impact USD event within 20 minutes.
```

### No trade

```text
No trade classification.
Both ORB boundaries were swept.
```

### Expired

```text
ORB trade window expired.
No new setups will be accepted today.
```

## 25.3 Anti-spam rules

- no duplicate notification for same event;
- cooldown between repeated setup notifications;
- notification acknowledgement;
- priority levels;
- muted states.

---

# 26. Live Trading Screen

The main screen must show:

## Header

- New York time;
- Nepal time;
- session state;
- selected symbol;
- selected strategy version;
- data status.

## Chart

- candlesticks;
- ORB high;
- ORB midpoint;
- ORB low;
- previous-day levels;
- current price;
- potential entry;
- stop;
- target;
- breakout and retest markers.

## Setup panel

- detected scenario;
- direction;
- rule pass count;
- blocking rules;
- waiting rules;
- manual checklist;
- final status.

## Risk panel

- account balance;
- risk percentage;
- risk amount;
- entry;
- stop;
- target;
- lot size;
- reward-to-risk;
- spread;
- permission.

## Actions

- confirm trade;
- skip;
- reject;
- mark missed;
- mark invalid;
- cancel setup;
- journal observation.

---

# 27. Research and Observation Mode

The user has not finalized all strategy rules, so the MVP must include observation mode.

## 27.1 Observation fields

- chart screenshot;
- session date;
- session preset;
- ORB values;
- scenario;
- what happened before setup;
- what caused entry consideration;
- what invalidated the setup;
- result after N candles;
- lesson;
- possible new rule.

## 27.2 Rule promotion process

```text
Raw observation
→ repeated pattern
→ experimental rule
→ historical backtest
→ demo forward test
→ supported rule
→ active strategy version
```

## 27.3 Evidence status

```text
PUBLICLY_REFERENCED
USER_OBSERVED
USER_INTERPRETATION
EXPERIMENTAL
BACKTEST_SUPPORTED
FORWARD_TEST_SUPPORTED
REJECTED
```

---

# 28. Historical Data Import

## 28.1 Supported input

CSV:

```csv
timestamp,open,high,low,close,volume,spread
2026-07-01T13:30:00Z,2328.10,2329.20,2327.80,2328.90,1000,0.25
```

## 28.2 Import wizard

1. select file;
2. map columns;
3. choose symbol;
4. choose timezone;
5. choose timeframe;
6. validate rows;
7. preview errors;
8. import;
9. produce data-quality report.

## 28.3 Validation

- unique timestamp;
- ordered candles;
- valid OHLC;
- expected interval;
- missing intervals;
- timezone known;
- numeric spread;
- no impossible negative prices.

---

# 29. Backtesting Engine

## 29.1 Goal

Replay historical sessions without future knowledge and evaluate the exact strategy version.

## 29.2 Pipeline

```text
Load data
Normalize timezone
Validate candles
Create session
Build and lock ORB
Process candles sequentially
Evaluate scenarios
Evaluate filters
Simulate entry
Apply spread and commission
Simulate stop and target
Record result
Calculate metrics
```

## 29.3 No look-ahead bias

The engine must never:

- use future candles;
- alter a locked range;
- use future swing points;
- choose the best stop after seeing outcome;
- choose target after seeing outcome.

## 29.4 Ambiguous candle handling

If one candle hits stop and target:

- use lower-timeframe data if available;
- otherwise use conservative assumption;
- mark result as ambiguous;
- allow report filtering.

## 29.5 Backtest outputs

- all detected setups;
- all traded setups;
- skipped setups;
- wins;
- losses;
- breakeven;
- total R;
- expectancy;
- profit factor;
- maximum drawdown;
- maximum consecutive losses;
- day-of-week results;
- direction results;
- range-width results;
- scenario results;
- entry-model results;
- stop-model results;
- target-model results;
- time-of-day results.

---

# 30. Journal System

Record both traded and untraded setups.

## 30.1 Setup record

- strategy version;
- session;
- ORB values;
- scenario;
- automatic rule results;
- manual checklist;
- screenshot;
- setup decision;
- reason.

## 30.2 Trade record

- planned entry;
- actual entry;
- planned stop;
- actual stop;
- planned target;
- actual exit;
- planned lot;
- actual lot;
- planned risk;
- actual result;
- commission;
- spread;
- slippage;
- result in money;
- result in R.

## 30.3 Behavioral record

- emotion before;
- confidence;
- sleep/readiness;
- revenge-trading risk;
- fear of missing out;
- rule violations;
- emotion after;
- lesson.

## 30.4 Process quality

```text
A = all rules followed
B = minor non-critical deviation
C = major rule violation
D = impulsive or unplanned trade
```

Outcome remains separate:

```text
WIN
LOSS
BREAKEVEN
SKIPPED
MISSED
CANCELLED
```

---

# 31. Analytics Dashboard

## 31.1 Primary metrics

- total sessions;
- total setups;
- total trades;
- win rate;
- average win in R;
- average loss in R;
- expectancy;
- profit factor;
- maximum drawdown;
- total R;
- consecutive losses;
- rule-compliance rate;
- no-trade days;
- missed setups.

## 31.2 Segment reports

- breakout continuation;
- breakout and retest;
- failed-breakout reversal;
- long vs short;
- day of week;
- session preset;
- range width;
- breakout time;
- candle quality;
- news context;
- spread;
- stop model;
- target model;
- strategy version.

## 31.3 Never optimize for win rate alone

The dashboard must emphasize:

```text
Expectancy
Profit Factor
Drawdown
Rule Compliance
Sample Size
```

---

# 32. Database Design

## 32.1 Core tables

```text
users
user_preferences
instruments
broker_specs
strategy_sources
strategies
strategy_versions
strategy_rules
strategy_rule_groups
strategy_parameters
trading_sessions
opening_ranges
candles
economic_events
setup_candidates
setup_rule_evaluations
manual_checklists
manual_checklist_answers
trade_plans
trades
trade_events
journal_entries
attachments
backtest_runs
backtest_trades
backtest_metrics
notifications
risk_profiles
risk_events
daily_performance
weekly_performance
audit_logs
```

## 32.2 Important relationships

```text
strategy
  has many strategy_versions

strategy_version
  has many strategy_rules

trading_session
  has one opening_range

setup_candidate
  belongs to strategy_version
  belongs to trading_session
  has many setup_rule_evaluations

trade_plan
  belongs to setup_candidate

trade
  belongs to trade_plan
  has many trade_events
  has one or more journal_entries
```

## 32.3 Suggested schema: strategy_versions

```sql
CREATE TABLE strategy_versions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  session_start TEXT NOT NULL,
  opening_range_minutes INTEGER NOT NULL,
  signal_timeframe_minutes INTEGER NOT NULL,
  configuration_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT,
  FOREIGN KEY (strategy_id) REFERENCES strategies(id)
);
```

## 32.4 Suggested schema: setup_candidates

```sql
CREATE TABLE setup_candidates (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  strategy_version_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  scenario TEXT NOT NULL,
  direction TEXT,
  status TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  expires_at TEXT,
  entry_price REAL,
  stop_price REAL,
  target_price REAL,
  final_reason TEXT,
  FOREIGN KEY (session_id) REFERENCES trading_sessions(id),
  FOREIGN KEY (strategy_version_id) REFERENCES strategy_versions(id)
);
```

---

# 33. API Design

## 33.1 Session APIs

```text
POST   /api/sessions/start
GET    /api/sessions/current
POST   /api/sessions/{id}/lock-range
POST   /api/sessions/{id}/complete
GET    /api/sessions/history
```

## 33.2 Strategy APIs

```text
GET    /api/strategies
POST   /api/strategies
GET    /api/strategies/{id}
POST   /api/strategies/{id}/versions
POST   /api/strategy-versions/{id}/activate
POST   /api/strategy-versions/{id}/retire
POST   /api/strategy-versions/{id}/clone
```

## 33.3 Setup APIs

```text
GET    /api/setups/current
GET    /api/setups/{id}
POST   /api/setups/{id}/confirm
POST   /api/setups/{id}/skip
POST   /api/setups/{id}/reject
POST   /api/setups/{id}/mark-missed
```

## 33.4 Risk APIs

```text
POST   /api/risk/calculate
GET    /api/risk/status
POST   /api/risk/profiles
PUT    /api/risk/profiles/{id}
```

## 33.5 Journal APIs

```text
POST   /api/journal
GET    /api/journal
GET    /api/journal/{id}
PUT    /api/journal/{id}
POST   /api/journal/{id}/attachments
```

## 33.6 Backtest APIs

```text
POST   /api/backtests
GET    /api/backtests
GET    /api/backtests/{id}
GET    /api/backtests/{id}/trades
GET    /api/backtests/{id}/metrics
```

---

# 34. Rule Engine Contract

```typescript
type RuleStatus = "PASS" | "FAIL" | "WAITING" | "NOT_APPLICABLE";

interface RuleContext {
  now: string;
  symbol: string;
  strategyVersionId: string;
  session: TradingSession;
  openingRange: OpeningRange;
  currentCandle: Candle;
  previousCandles: Candle[];
  spread?: number;
  newsStatus: NewsStatus;
  riskStatus: RiskStatus;
}

interface RuleEvaluation {
  ruleCode: string;
  name: string;
  status: RuleStatus;
  blocking: boolean;
  source: "AUTOMATIC" | "MANUAL";
  actualValue?: string | number | boolean | null;
  requiredValue?: string | number | boolean | null;
  explanation: string;
}
```

## 34.1 Example rule

```typescript
class CloseAboveOrbHighRule {
  evaluate(context: RuleContext): RuleEvaluation {
    const passed =
      context.currentCandle.close > context.openingRange.high;

    return {
      ruleCode: "CLOSE_ABOVE_ORB_HIGH",
      name: "Candle closes above ORB high",
      status: passed ? "PASS" : "FAIL",
      blocking: true,
      source: "AUTOMATIC",
      actualValue: context.currentCandle.close,
      requiredValue: context.openingRange.high,
      explanation: passed
        ? "The completed candle closed above the ORB high."
        : "The completed candle did not close above the ORB high."
    };
  }
}
```

---

# 35. Recommended Repository Structure

```text
personal-orb-guide/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── features/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── sessions/
│   │   │   │   ├── chart/
│   │   │   │   ├── strategies/
│   │   │   │   ├── setups/
│   │   │   │   ├── risk/
│   │   │   │   ├── journal/
│   │   │   │   └── analytics/
│   │   │   └── shared/
│   │   └── package.json
│   │
│   ├── api/
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── identity/
│   │   │   │   ├── instruments/
│   │   │   │   ├── strategies/
│   │   │   │   ├── sessions/
│   │   │   │   ├── opening-range/
│   │   │   │   ├── signals/
│   │   │   │   ├── risk/
│   │   │   │   ├── trades/
│   │   │   │   ├── journal/
│   │   │   │   ├── notifications/
│   │   │   │   └── analytics/
│   │   │   └── infrastructure/
│   │   └── package.json
│   │
│   └── quant/
│       ├── app/
│       │   ├── backtesting/
│       │   ├── indicators/
│       │   ├── importers/
│       │   ├── metrics/
│       │   └── api/
│       └── requirements.txt
│
├── packages/
│   ├── shared-types/
│   ├── strategy-engine/
│   ├── rule-engine/
│   └── risk-engine/
│
├── data/
│   ├── imports/
│   ├── exports/
│   ├── screenshots/
│   └── backups/
│
├── docker-compose.yml
├── .env.example
├── README.md
└── docs/
    └── ORB_MVP_SPEC.md
```

---

# 36. Free Local Deployment

## 36.1 Simplest MVP

```text
React frontend
Node API
SQLite database
Python quant service
Local files
```

## 36.2 Local ports

```text
Frontend: http://localhost:3000
API: http://localhost:7070
Quant: http://localhost:8000
```

## 36.3 Optional Docker Compose

```yaml
services:
  web:
    build: ./apps/web
    ports:
      - "3000:3000"

  api:
    build: ./apps/api
    ports:
      - "7070:7070"
    volumes:
      - ./data:/app/data

  quant:
    build: ./apps/quant
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
```

SQLite remains inside the shared local data directory.

---

# 37. MVP Implementation Order

## Phase 1: Foundation

Build:

- monorepo;
- local database;
- personal settings;
- instrument settings;
- strategy versions;
- New York timezone;
- session scheduler.

Acceptance:

- user can configure XAUUSD broker specifications;
- user can select session preset;
- strategy version can be activated.

## Phase 2: ORB Engine

Build:

- candle model;
- CSV importer;
- opening-range calculation;
- ORB high/midpoint/low;
- chart rendering;
- range locking.

Acceptance:

- historical session can be loaded;
- ORB levels are calculated correctly;
- levels cannot repaint after locking.

## Phase 3: Scenario and Rule Engine

Build:

- clean breakout;
- retest;
- failed breakout;
- midpoint tracking;
- double-sided sweep;
- no-trade classification;
- rule explanations.

Acceptance:

- every setup shows pass/fail/waiting rules;
- every scenario is independently classified.

## Phase 4: Risk and Trade Guide

Build:

- broker spec settings;
- risk calculator;
- lot-size calculator;
- stop and target models;
- pre-trade checklist;
- final trade guidance.

Acceptance:

- invalid risk blocks setup;
- valid setup requires manual confirmation.

## Phase 5: Notifications

Build:

- browser permission;
- local notifications;
- alert cooldown;
- event preferences.

Acceptance:

- ORB lock, potential breakout, retest, ready, blocked, and expired alerts work.

## Phase 6: Journal

Build:

- setup journal;
- trade journal;
- screenshots;
- behavior tracking;
- process grades.

Acceptance:

- traded and skipped setups are stored.

## Phase 7: Backtesting

Build:

- sequential replay;
- setup simulation;
- spread and commission;
- stop/target processing;
- metrics.

Acceptance:

- strategy version can be tested over imported data;
- results are reproducible.

## Phase 8: Analytics

Build:

- overview;
- scenario comparison;
- range-width analysis;
- long/short analysis;
- day/time analysis;
- compliance analysis.

---

# 38. Initial Strategy Configuration

Use this as the first research configuration.

```json
{
  "name": "Max-Inspired XAUUSD NY ORB",
  "version": "0.1.0",
  "status": "RESEARCH",
  "symbol": "XAUUSD",
  "timezone": "America/New_York",
  "sessionStart": "09:30",
  "openingRangeMinutes": 15,
  "signalTimeframeMinutes": 5,
  "tradeWindowEnd": "11:30",

  "enabledScenarios": {
    "cleanBreakout": true,
    "breakoutRetest": true,
    "failedBreakoutReversal": true,
    "midpointReaction": "RECORD_ONLY",
    "doubleSidedSweep": "BLOCK_CONTINUATION",
    "chopDetection": true
  },

  "breakout": {
    "requireCompletedCandle": true,
    "requireCloseOutside": true,
    "allowWickOnly": false,
    "minimumBodyRatio": 0.55,
    "minimumCloseLocationRatio": 0.65,
    "maximumEntryExtensionPercentOfRange": 0.25
  },

  "retest": {
    "enabled": true,
    "zonePercentOfRange": 0.10,
    "maximumCandles": 6,
    "confirmationRequired": true
  },

  "rangeFilter": {
    "mode": "WARN_ONLY",
    "minimumWidth": null,
    "maximumWidth": null
  },

  "trendFilter": {
    "mode": "RECORD_ONLY"
  },

  "newsFilter": {
    "enabled": true,
    "mode": "BLOCK",
    "manualEvents": true
  },

  "risk": {
    "riskPerTradePercent": 0.25,
    "maximumDailyLossPercent": 0.75,
    "maximumWeeklyLossPercent": 2.0,
    "maximumTradesPerSession": 1,
    "maximumConsecutiveLosses": 3,
    "mandatoryStopLoss": true,
    "minimumRewardToRisk": 1.5,
    "allowMartingale": false,
    "allowAddingToLoss": false
  },

  "execution": {
    "mode": "MANUAL",
    "manualConfirmationRequired": true
  }
}
```

The values above are research defaults, not validated performance claims.

---

# 39. Daily User Workflow

## Before session

1. Open the application.
2. Confirm active strategy version.
3. Enter account balance/equity.
4. Review manual USD news events.
5. Confirm broker spread.
6. Complete readiness checklist.
7. Start session.

## During opening range

1. Application displays `DO NOT TRADE`.
2. ORB is built candle by candle.
3. Current high, low, midpoint, and width are shown.
4. Range locks after 15 minutes.

## After range lock

1. Application changes to `WAITING FOR SETUP`.
2. It monitors all enabled scenarios.
3. It sends candidate notifications.
4. It evaluates rules only on completed candles.

## When setup is ready

1. Show scenario and direction.
2. Show all rules.
3. Calculate entry, stop, target, risk, and lot.
4. Require manual checklist.
5. User confirms or skips.
6. User executes manually at broker.
7. User records actual execution.

## After trade

1. Record outcome.
2. Add screenshots.
3. Add emotion and lessons.
4. Grade process.
5. Complete session review.

---

# 40. Acceptance Criteria for the Complete MVP

The MVP is considered complete when:

- XAUUSD can be configured using broker-specific values;
- New York session works correctly across daylight-saving changes;
- 15-minute ORB is created and locked;
- ORB high, midpoint, and low are shown on chart;
- clean breakout long and short are detected;
- retest states are tracked;
- failed breakouts are detected;
- midpoint crossings are tracked;
- double-sided sweeps block continuation trades;
- no-trade sessions are classified;
- every rule is explainable;
- risk engine calculates and blocks invalid trades;
- position size respects broker specifications;
- manual checklist is mandatory;
- browser notifications work;
- all setups can be journaled;
- CSV historical data can be imported;
- strategy versions can be backtested;
- analytics compare scenarios;
- everything runs locally without paid services.

---

# 41. Future Improvements

After six months of data, consider:

- automated live data from a free broker source;
- additional pairs;
- session-specific strategy versions;
- better structure detection;
- volume or tick-volume analysis;
- local AI journal summaries;
- broker statement import;
- demo execution integration;
- mobile-responsive interface;
- encrypted local backups;
- optional home-network access.

Do not add automatic execution until:

- strategy rules are stable;
- forward test is complete;
- risk controls are proven;
- broker reconciliation is reliable;
- manual results show positive expectancy after costs.

---

# 42. Final Product Definition

The final MVP is:

> A free, local-first, personal XAUUSD New York ORB trading guide that calculates the opening range, detects Max-inspired breakout and reversal scenarios, validates trade conditions, calculates risk, notifies the user when conditions match, requires manual confirmation, journals every decision, and backtests strategy versions without promising profitable outcomes.

The software must help the user follow rules consistently. Its most valuable output is sometimes:

```text
NO TRADE
```

A valid system is not one that generates many signals. It is one that clearly separates:

- valid setups;
- incomplete setups;
- risky setups;
- invalid setups;
- missed opportunities;
- disciplined no-trade sessions.
