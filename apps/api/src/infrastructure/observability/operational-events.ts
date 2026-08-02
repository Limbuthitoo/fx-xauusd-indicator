import { config } from "../config.js";
import { query } from "../db/client.js";

type OperationalEventInput = {
  severity?: "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";
  category: "API" | "DB" | "TWELVE_DATA" | "AUTH" | "WORKER" | "FRONTEND" | "SECURITY" | "SYSTEM";
  eventType: string;
  source: string;
  requestId?: string | null;
  route?: string | null;
  method?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  tenantId?: string | null;
  adminUserId?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
};

let lastRetentionRun = 0;

export async function recordOperationalEvent(input: OperationalEventInput) {
  await query(
    `INSERT INTO operational_events (
       severity, category, event_type, source, request_id, route, method, status_code,
       duration_ms, tenant_id, admin_user_id, message, metadata
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [
      input.severity ?? "INFO",
      input.category,
      input.eventType,
      input.source,
      input.requestId ?? null,
      input.route ?? null,
      input.method ?? null,
      input.statusCode ?? null,
      input.durationMs ?? null,
      input.tenantId ?? null,
      input.adminUserId ?? null,
      input.message,
      JSON.stringify(input.metadata ?? {})
    ]
  ).catch(() => undefined);
}

export async function cleanupOperationalEvents() {
  const now = Date.now();
  if (now - lastRetentionRun < 60 * 60_000) return;
  lastRetentionRun = now;
  await Promise.all([
    deleteOlderThan("operational_events", "created_at", config.operationalEventRetentionDays),
    deleteOlderThan("security_events", "created_at", config.securityEventRetentionDays),
    deleteOlderThan("api_usage_events", "created_at", config.apiUsageRetentionDays),
    deleteOlderThan("worker_heartbeats", "heartbeat_at", config.workerHeartbeatRetentionDays, "worker_name <> 'market-data-worker'")
  ]).catch(() => undefined);
}

async function deleteOlderThan(table: string, column: string, days: number, extraWhere?: string) {
  const where = [`${column} < now() - ($1::text || ' days')::interval`];
  if (extraWhere) where.push(extraWhere);
  await query(`DELETE FROM ${table} WHERE ${where.join(" AND ")}`, [String(Math.max(days, 1))]);
}
