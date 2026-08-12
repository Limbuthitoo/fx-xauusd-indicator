# Historical Strategy Validation

This workflow validates Module 1 and Module 2 against historical XAUUSD 5-minute candles without inserting those candles into the live `candles` table. Historical research data is stored in `strategy_validation_*` tables and is not affected by the seven-day live-candle retention job.

## Dataset format

Import CSV or JSON with these fields:

```text
timestamp_utc,open,high,low,close,volume,spread
```

`volume` and `spread` are optional. Use ISO-8601 UTC timestamps when possible. PostgreSQL timestamp exports such as `2026-08-05 06:20:00+00` are also accepted.

## Commands

Apply migrations first:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod-tools run --rm migrate
```

Import an isolated historical dataset:

```bash
npm run validation:history -- import \
  --file /path/to/xauusd-5m.csv \
  --name xauusd-100-ny-sessions \
  --source HISTORICAL_PROVIDER \
  --env .env.production
```

Run a chronological 70/30 replay:

```bash
VALIDATION_REPLAY_WORKERS=4 npm run validation:history -- run \
  --dataset xauusd-100-ny-sessions \
  --train-ratio 0.7 \
  --env .env.production
```

Show the latest report:

```bash
npm run validation:history -- report --env .env.production
```

List imported datasets:

```bash
npm run validation:history -- list --env .env.production
```

Use `--replace` during import only when intentionally replacing a research dataset with the same name. It never deletes live candles.

## Evidence rules

- Module 1 profiles and Module 2 variants are replayed through their actual TypeScript strategy engines.
- Module 2 variants are recorded independently, while `__ALL__` module totals deduplicate variants representing the same sweep thesis.
- Same-candle TP and SL collisions are scored conservatively as a loss and marked ambiguous.
- The split is chronological. The last 30% of sessions is untouched validation data, not a random sample.
- A profile needs at least 30 resolved validation signals and a dataset of at least 60 NY sessions before a release decision can be enforced.
- Default eligibility requires positive total R and expectancy, at least 40% wins, profit factor at least 1.2, and maximum drawdown no greater than 10R.
- Small samples create `INSUFFICIENT_DATA` gates with `enforced=false`; they cannot disable live profiles.

Thresholds can be changed through `VALIDATION_MINIMUM_DATASET_SESSIONS`, `VALIDATION_MINIMUM_RESOLVED_PROFILE`, `VALIDATION_MINIMUM_PROFIT_FACTOR`, `VALIDATION_MINIMUM_WIN_RATE`, and `VALIDATION_MAXIMUM_DRAWDOWN_R`. Changes must be recorded as a new validation run rather than applied retroactively.

## Database verification

```sql
SELECT name, status, candle_count, session_count, start_at, end_at
FROM strategy_validation_datasets
ORDER BY created_at DESC;

SELECT partition, module_code, profile_code, signal_count, resolved_count,
       win_rate, profit_factor, expectancy_r, total_r, max_drawdown_r, eligible
FROM strategy_validation_metrics
WHERE run_id = 'RUN_UUID'
ORDER BY partition, module_code, profile_code;

SELECT module_code, profile_code, status, enforced, resolved_count, reasons
FROM strategy_release_gates
ORDER BY module_code, profile_code;
```

Historical replay is intentionally an offline batch. It does not call Twelve Data, create tenant BUY/SELL notifications, or open paper trades.

## Platform dashboard and live enforcement

Platform super admins can review datasets, chronological runs, validation metrics, and profile gates at:

```text
/platform-admin/validation
```

Only an exact profile gate with `enforced=true` affects the live MVP path. An enforced `BLOCKED` profile is retained as blocked setup evidence but cannot produce a BUY/SELL card, entry notification, or automatic paper-trade row. Missing gates and `INSUFFICIENT_DATA` gates fail open so small or unavailable samples do not change live behavior. Module aggregate (`__ALL__`) rows are informational and do not disable otherwise eligible profiles.

Run the complete production validator after migration and service restart:

```bash
npm run validate:mvp-runtime -- .env.production
```

This additionally verifies that all six validation tables exist, insufficient samples are not enforced, and blocked profiles have not leaked into post-gate signal or paper-trade artifacts.
