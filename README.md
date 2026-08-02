# Personal XAUUSD New York ORB Trading Guide

Local-first trading guide system for the Max-inspired XAUUSD New York ORB research workflow.

This app gives deterministic guidance such as `WAIT`, `WAIT FOR RETEST`, `LONG SETUP READY`, `SHORT SETUP READY`, `NO TRADE`, and `BLOCKED`. It never places broker orders and never promises profitable trades.

## Stack

- React, TypeScript, Vite web app
- Fastify TypeScript API
- PostgreSQL database
- Python FastAPI quant service
- Pandas and NumPy for CSV validation/backtesting
- Docker Compose for local PostgreSQL

## Run Locally

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:web
```

Open `http://localhost:3000`.

## What Is Included

- PostgreSQL schema for the full MVP table set from the guide
- Seeded XAUUSD instrument, broker spec, strategy source, active research strategy version, and risk profile
- Session scheduler using `America/New_York` instead of hard-coded UTC offsets
- Opening range calculation and locking
- Scenario detection for clean breakout, retest wait, failed breakout reversal observation, midpoint chop, and double-sided sweep
- Explainable rule evaluations
- Independent risk and position sizing calculator
- Manual checklist surface
- Journal endpoints
- Candle import endpoint
- Backtest run records and Python sequential replay service
- Analytics overview and scenario counts
- MT5/Exness-compatible market-data sync path through the Python quant service
- Automatic MT5 ingestion worker with ORB lock/evaluation and notifications

## Live Data

The chart reads candles from PostgreSQL as the local candle cache. The live provider can be Twelve Data or the MT5 Bridge, and each live candle is written to PostgreSQL before the chart and ORB engine use it.

For Twelve Data, add this to `.env` and restart the API:

```text
TWELVE_DATA_API_KEY=your_key_here
TWELVE_DATA_SYMBOL=XAU/USD
TWELVE_DATA_INTERVAL=15min
TWELVE_DATA_POLL_SECONDS=60
```

Twelve Data Basic Free is 800 credits/day and 8 credits/minute. The auto-run scheduler starts polling 15 minutes before the configured New York session start and stops at the configured New York session end/trade-window end. While running, it polls once per minute by default. Treat this as indicative chart data; your broker price can differ.

For MT5 broker data, connect MetaTrader 5 with your broker/demo account and attach the bridge EA.

See [docs/MT5_EXNESS_DATA_FEED.md](docs/MT5_EXNESS_DATA_FEED.md).

## PostgreSQL

The original guide suggested SQLite for the simplest MVP. This implementation uses PostgreSQL per request.

Default local connection:

```text
postgres://orb_user:orb_password@localhost:5433/orb_guide
```
