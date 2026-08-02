# Backup And Restore Runbook

## Create A Backup

```bash
npm run db:backup
```

Backups are written to `backups/postgres` by default as timestamped PostgreSQL custom dumps.

## Restore A Backup

```bash
npm run db:restore -- backups/postgres/orb_guide_YYYYMMDDTHHMMSSZ.dump
```

The restore command uses the Docker Postgres container when it is running. Otherwise it uses local `pg_restore` with `DATABASE_URL`.

## Cleanup Old Backups

```bash
npm run db:backup:retention
```

Default backup retention is `14` days. Override with `BACKUP_RETENTION_DAYS`.

## Verify After Restore

1. Run `npm run db:migrate`.
2. Start the API and worker.
3. Open Platform Admin System Health.
4. Confirm PostgreSQL, Redis, worker heartbeat, and Twelve Data guardrail are healthy.
5. Confirm subscribers, modules, paper trades, and reports are visible.

## Redis Note

Redis is used for shared operational state such as login rate limiting. Local development can fall back without Redis when `REDIS_REQUIRED=false`, but production should run Redis and set `REDIS_URL`. The Docker Redis service publishes to host port `6380` by default to avoid conflicting with any existing local Redis on `6379`.
