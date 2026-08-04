import { Client } from "pg";
import Redis from "ioredis";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const apiHealthUrl = process.env.API_HEALTH_URL || "http://api:7073/api/health";
const quantHealthUrl = process.env.QUANT_HEALTH_URL || "";
const intervalSeconds = Number(process.env.MONITOR_INTERVAL_SECONDS || 60);
const workerMaxAgeSeconds = Number(process.env.MONITOR_WORKER_MAX_AGE_SECONDS || 180);

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for ops monitor.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastStatus = null;

async function checkHttp(name, url) {
  const started = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${name} returned ${response.status}: ${body.slice(0, 180)}`);
  return { ok: true, latencyMs: Date.now() - started };
}

async function checkPostgres(client) {
  const current = await client.query("SELECT now() AS now");
  const heartbeat = await client.query(
    `SELECT heartbeat_at, extract(epoch FROM (now() - heartbeat_at))::int AS age_seconds
     FROM worker_heartbeats
     WHERE worker_name = 'market-data-worker'
     ORDER BY heartbeat_at DESC
     LIMIT 1`
  );
  const row = heartbeat.rows[0];
  const ageSeconds = Number(row?.age_seconds ?? Number.POSITIVE_INFINITY);
  if (!row || ageSeconds > workerMaxAgeSeconds) {
    throw new Error(`market-data-worker heartbeat is stale: ${Number.isFinite(ageSeconds) ? `${ageSeconds}s` : "missing"}`);
  }
  return { ok: true, now: current.rows[0]?.now, workerHeartbeatAgeSeconds: ageSeconds };
}

async function checkRedis() {
  if (!redisUrl) return { ok: true, skipped: true };
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: true });
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`unexpected redis ping response ${pong}`);
    return { ok: true };
  } finally {
    redis.disconnect();
  }
}

async function writeEvent(client, severity, status, checks, error) {
  const message = status === "HEALTHY" ? "Ops monitor checks are healthy." : `Ops monitor detected ${status.toLowerCase()} status.`;
  await client.query(
    `INSERT INTO operational_events (severity, category, event_type, source, message, metadata)
     VALUES ($1, 'SYSTEM', 'OPS_MONITOR_STATUS', 'ops-monitor', $2, $3::jsonb)`,
    [
      severity,
      message,
      JSON.stringify({
        status,
        checks,
        error: error ? String(error?.message ?? error) : null,
        generatedAt: new Date().toISOString()
      })
    ]
  );
}

async function runOnce(client) {
  const checks = {};
  checks.api = await checkHttp("api", apiHealthUrl);
  checks.postgres = await checkPostgres(client);
  checks.redis = await checkRedis();
  if (quantHealthUrl) checks.quant = await checkHttp("quant", quantHealthUrl);
  return checks;
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  console.log(`ops-monitor started; interval=${intervalSeconds}s api=${apiHealthUrl}`);
  while (true) {
    try {
      const checks = await runOnce(client);
      if (lastStatus !== "HEALTHY") {
        await writeEvent(client, "INFO", "HEALTHY", checks, null);
      }
      lastStatus = "HEALTHY";
      console.log(JSON.stringify({ status: "HEALTHY", checks, at: new Date().toISOString() }));
    } catch (error) {
      const status = "DEGRADED";
      if (lastStatus !== status) {
        await writeEvent(client, "ERROR", status, {}, error);
      }
      lastStatus = status;
      console.error(JSON.stringify({ status, error: String(error?.message ?? error), at: new Date().toISOString() }));
    }
    await sleep(Math.max(15, intervalSeconds) * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
