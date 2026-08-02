# XAUUSD ORB MVP Implementation Notes

This repository implements the guide in `Personal_XAUUSD_ORB_Trading_Guide_MVP_COMPLETE.md`.

The user requested PostgreSQL, so the local-first database recommendation from the guide was adapted from SQLite to PostgreSQL. The rest of the product constraints remain intact:

- manual trade execution only;
- deterministic rule and risk engines;
- strategy versioning;
- explainable pass/fail/waiting rule evaluations;
- local browser notifications;
- journal and backtest records;
- no profitability promises.

## Local Ports

- Web: `http://localhost:3000`
- API: `http://localhost:7070`
- Quant: `http://localhost:8000`
- PostgreSQL: `localhost:5433`

## Quick Start

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:web
```

For the Python quant service:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r apps/quant/requirements.txt
npm run dev:quant
```

## Main API Workflows

- `POST /api/sessions/start`
- `GET /api/sessions/current`
- `POST /api/sessions/{id}/lock-range`
- `POST /api/imports/candles`
- `POST /api/setups/evaluate`
- `POST /api/risk/calculate`
- `POST /api/journal`
- `POST /api/backtests`
- `GET /api/analytics/overview`

## CSV Candle Shape

```csv
timestamp,open,high,low,close,volume,spread
2026-07-01T13:30:00Z,2328.10,2329.20,2327.80,2328.90,1000,0.25
```
