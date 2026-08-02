# MT5 + Exness Local Data Feed

This app uses MetaTrader 5 as the free local market-data provider through the MT5 Bridge EA.

Flow:

```text
Exness account
-> MetaTrader 5 terminal
-> MT5 Bridge EA WebRequest
-> Node API bridge endpoint
-> PostgreSQL candles table
-> React live chart and indicators
```

The app does not place broker orders. It reads market data only.

## Requirements

- Exness demo or live account
- MetaTrader 5 terminal installed and logged in
- `XAUUSD` visible in MT5 Market Watch
- MT5 Bridge EA attached to an XAUUSD M5 chart
- WebRequest allowed for the API base URL

The Python `MetaTrader5` package is optional and is not the recommended path on macOS. On this project, use the bridge EA for proper live candles.

## MT5 Bridge Setup

Use the MQL5 bridge template:

[MT5_BRIDGE_EA_TEMPLATE.mq5](MT5_BRIDGE_EA_TEMPLATE.mq5)

Attach it to an XAUUSD M5 chart. By default it posts the current forming 5-minute candle every 5 seconds into:

```text
POST http://localhost:7071/api/market-data/bridge/candles
```

In MT5:

```text
Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL
http://localhost:7071
```

If MT5 is running inside Parallels/Crossover/Wine and `localhost` does not reach the Mac API, use the Mac LAN IP instead:

```text
http://192.168.1.100:7071/api/market-data/bridge/candles
```

Then allow the matching base URL in MT5:

```text
http://192.168.1.100:7071
```

## Start Services

```bash
docker compose up -d postgres
DATABASE_URL=postgres://orb_user:orb_password@localhost:5433/orb_guide npm run dev:api
npm run dev:web
npm run dev:quant
```

If the API is running on a fallback port:

```bash
VITE_API_BASE_URL=http://localhost:7071 npm run dev:web
```

## Dashboard Controls

Main dashboard:

- `Activate Bridge` prepares today's NY ORB session and checks whether bridge candles are arriving.
- `Refresh` reloads chart, indicators, paper trades, and feed status.
- `Alerts` enables browser notifications.

Chart toolbar:

- `Bridge` checks the latest MT5 bridge candle.
- `Refresh` reloads the chart.

When the EA posts a candle, the API automatically:

```text
-> upsert into PostgreSQL
-> auto-lock active ORB when the opening range is complete
-> evaluate the newest signal candle
-> create automatic paper BUY/SELL when valid
-> close paper trade at TP or SL
-> update journal and reports
```

## API Endpoints

Quant service:

- `GET /market-data/mt5/status`
- `GET /market-data/mt5/price/XAUUSD`
- `GET /market-data/mt5/candles/XAUUSD?timeframe_minutes=5&count=300`
- `GET /market-data/mt5/symbol-info/XAUUSD`

These quant MT5 endpoints are optional and usually Windows-only.

Node API:

- `POST /api/market-data/bridge/candles`
- `GET /api/market-data/bridge/status?symbol=XAUUSD&timeframeMinutes=5`
- `GET /api/market-data/live/status?symbol=XAUUSD&timeframeMinutes=5`
- `GET /api/notifications?unacknowledged=true`

Example live status check:

```bash
curl 'http://localhost:7071/api/market-data/live/status?symbol=XAUUSD&timeframeMinutes=5'
```

Example bridge candle POST:

```bash
curl -X POST http://localhost:7071/api/market-data/bridge/candles \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"XAUUSD","timeframeMinutes":5,"source":"MT5_BRIDGE_TEST","candles":[{"timestamp":"2026-07-31T13:35:00Z","open":2400,"high":2401,"low":2399,"close":2400.5,"volume":100,"spread":0.2}]}'
```

## Notes

- Broker symbol names may differ, for example `XAUUSD`, `XAUUSDm`, or `XAUUSD.`.
- If Exness uses a suffix, use that exact MT5 symbol and map it to your preferred display name later.
- Broker specs such as tick value, contract size, lot step, and minimum lot can be entered later if needed.
- The live chart does not fetch market data directly. It reads PostgreSQL so the strategy engine, backtests, journal, and chart all use the same candle record.
- PostgreSQL is storage/cache, not the market provider.
- For a moving realtime chart, keep `PostFormingCandle=true` in the EA. For strict closed-candle-only strategy testing, set it to `false`.

The live architecture is:

```text
MT5 broker chart -> MT5 Bridge EA -> Node API -> PostgreSQL cache -> chart/rules/reports
```
