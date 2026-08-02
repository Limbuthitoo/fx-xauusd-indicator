# Rollback Runbook

## Fast Application Rollback

1. Identify the previous known-good Docker image/tag or Git revision.
2. Stop app services:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod stop api worker web
```

3. Rebuild or pull the previous version.
4. Start services:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile prod up -d api worker web
```

5. Run:

```bash
npm run deploy:verify
```

## Database Rollback

Only restore the database if the release corrupted data or migrations are not forward-compatible.

1. Stop API and worker.
2. Restore the selected backup:

```bash
npm run db:restore -- backups/postgres/orb_guide_YYYYMMDDTHHMMSSZ.dump
```

3. Run migrations for the rolled-back version.
4. Start API and worker.
5. Run `npm run deploy:verify`.

## Redis Rollback

Redis stores shared operational state such as login rate limits. If Redis data is bad, restart Redis after stopping API/worker:

```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml restart redis
```

## Required Checks After Rollback

- API health is OK.
- PostgreSQL health is OK.
- Redis health is OK.
- Worker heartbeat is fresh.
- Twelve Data worker mode is `DEDICATED_WORKER_READY`.
- Backup status is healthy.
