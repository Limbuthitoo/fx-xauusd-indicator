import type { NewsStatus } from "@orb-guide/shared-types";
import { config } from "../../infrastructure/config.js";
import { pool, query } from "../../infrastructure/db/client.js";
import { recordOperationalEvent } from "../../infrastructure/observability/operational-events.js";
import { fetchOfficialUsCalendar, OFFICIAL_US_PROVIDER } from "./official-us-calendar.js";

let eventStatusCache: { key: string; expiresAt: number; value: EconomicEventState } | null = null;

export type EconomicEvent = {
  id?: string;
  title: string;
  affected_currency: string;
  impact: string;
  event_time_utc: string | Date;
  block_before_minutes: number;
  block_after_minutes: number;
  override_status?: string | null;
  override_reason?: string | null;
  provider?: string;
  external_event_id?: string | null;
};

export type EconomicEventState = {
  status: NewsStatus;
  reason: string;
  activeEvent: EconomicEvent | null;
  events: EconomicEvent[];
  evaluatedAt: string;
  automation?: EconomicCalendarAutomationState;
};

export type EconomicCalendarAutomationState = {
  provider: string;
  automated: boolean;
  configured: boolean;
  status: "MANUAL" | "HEALTHY" | "WARN" | "STALE" | "NOT_READY" | "ERROR";
  stale: boolean;
  reason: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  coverageStartAt: string | null;
  coverageEndAt: string | null;
  eventsUpserted: number;
  upcomingHighImpactEvents: number;
};

export function classifyEconomicEvents(events: EconomicEvent[], evaluatedAt: string | Date = new Date()): EconomicEventState {
  const at = new Date(evaluatedAt);
  let status: NewsStatus = "CLEAR";
  let activeEvent: EconomicEvent | null = null;
  let reason = "No high-impact USD or gold event is inside the configured protection window.";

  for (const event of events) {
    const override = String(event.override_status ?? "").toUpperCase();
    if (override === "CLEAR") continue;
    if (override === "BLOCKED") {
      return {
        status: "MANUAL_OVERRIDE",
        reason: event.override_reason || `${event.title} is manually blocking new entries.`,
        activeEvent: event,
        events,
        evaluatedAt: at.toISOString()
      };
    }
    const eventTime = new Date(event.event_time_utc);
    const before = new Date(eventTime.getTime() - Number(event.block_before_minutes) * 60_000);
    const after = new Date(eventTime.getTime() + Number(event.block_after_minutes) * 60_000);
    if (at >= before && at < eventTime) {
      status = "BLOCKED_BEFORE_EVENT";
      activeEvent = event;
      reason = `${event.title} is inside the pre-event protection window.`;
      break;
    }
    if (at >= eventTime && at <= after) {
      status = "BLOCKED_AFTER_EVENT";
      activeEvent = event;
      reason = `${event.title} is inside the post-event stabilization window.`;
      break;
    }
    if (eventTime.getTime() > at.getTime() && eventTime.getTime() - at.getTime() <= 60 * 60_000) {
      status = "UPCOMING_WARNING";
      activeEvent = event;
      reason = `${event.title} is due within one hour.`;
    }
  }

  return { status, reason, activeEvent, events, evaluatedAt: at.toISOString() };
}

export function calendarFreshness(input: {
  evaluatedAt: string | Date;
  lastSuccessAt?: string | Date | null;
  coverageEndAt?: string | Date | null;
  staleHours: number;
}) {
  const at = new Date(input.evaluatedAt);
  const lastSuccess = input.lastSuccessAt ? new Date(input.lastSuccessAt) : null;
  const coverageEnd = input.coverageEndAt ? new Date(input.coverageEndAt) : null;
  const staleByAge = !lastSuccess || at.getTime() - lastSuccess.getTime() > input.staleHours * 60 * 60_000;
  const staleByCoverage = !coverageEnd || coverageEnd.getTime() < at.getTime() + 24 * 60 * 60_000;
  return { stale: staleByAge || staleByCoverage, staleByAge, staleByCoverage };
}

export async function economicCalendarAutomationStatus(evaluatedAt: string | Date = new Date()): Promise<EconomicCalendarAutomationState> {
  const provider = configuredCalendarProvider();
  const automated = provider !== "MANUAL";
  const configured = true;
  const at = new Date(evaluatedAt);
  if (!automated) {
    const count = await upcomingEventCount(at);
    return {
      provider,
      automated,
      configured: true,
      status: "MANUAL",
      stale: false,
      reason: "Economic events are maintained manually.",
      lastAttemptAt: null,
      lastSuccessAt: null,
      coverageStartAt: null,
      coverageEndAt: null,
      eventsUpserted: 0,
      upcomingHighImpactEvents: count
    };
  }
  const { rows } = await query(
    `SELECT * FROM economic_calendar_sync_state WHERE provider = $1 LIMIT 1`,
    [provider]
  );
  const row = rows[0] as any;
  const count = await upcomingEventCount(at);
  const lastSuccessAt = row?.last_success_at ? new Date(row.last_success_at) : null;
  const coverageEndAt = row?.coverage_end_at ? new Date(row.coverage_end_at) : null;
  const freshness = calendarFreshness({
    evaluatedAt: at,
    lastSuccessAt,
    coverageEndAt,
    staleHours: config.economicCalendarStaleHours
  });
  const { staleByAge, staleByCoverage } = freshness;
  const emptyCoverage = Boolean(row?.last_success_at) && Number(row?.events_upserted ?? 0) === 0 && count === 0;
  const stale = freshness.stale || emptyCoverage;
  const status = stale ? (row?.status === "ERROR" ? "ERROR" : row ? "STALE" : "NOT_READY") : row?.status === "ERROR" ? "WARN" : "HEALTHY";
  const reason = emptyCoverage
    ? "Automated synchronization returned no high-impact US events for its forward coverage window."
    : staleByAge
      ? `Economic calendar has not synchronized successfully within ${config.economicCalendarStaleHours} hours.`
      : staleByCoverage
        ? "Economic calendar coverage does not extend at least 24 hours ahead."
        : row?.status === "ERROR"
          ? "The latest synchronization failed, but retained calendar coverage is still current."
          : "Automated high-impact US calendar coverage is current.";
  return {
    provider,
    automated,
    configured,
    status,
    stale,
    reason,
    lastAttemptAt: row?.last_attempt_at ?? null,
    lastSuccessAt: row?.last_success_at ?? null,
    coverageStartAt: row?.coverage_start_at ?? null,
    coverageEndAt: row?.coverage_end_at ?? null,
    eventsUpserted: Number(row?.events_upserted ?? 0),
    upcomingHighImpactEvents: count
  };
}

export async function economicEventStatus(evaluatedAt: string | Date = new Date()) {
  const at = new Date(evaluatedAt);
  const cacheKey = `${configuredCalendarProvider()}:${at.toISOString().slice(0, 16)}`;
  if (eventStatusCache?.key === cacheKey && eventStatusCache.expiresAt > Date.now()) return eventStatusCache.value;
  const [{ rows }, automation] = await Promise.all([
    query(
      `SELECT *
       FROM economic_events
       WHERE affected_currency IN ('USD', 'XAU', 'ALL')
         AND upper(impact) IN ('HIGH', 'CRITICAL')
         AND event_time_utc >= $1::timestamptz - interval '4 hours'
         AND event_time_utc <= $1::timestamptz + interval '24 hours'
       ORDER BY event_time_utc ASC`,
      [at.toISOString()]
    ),
    economicCalendarAutomationStatus(at)
  ]);
  const classified = classifyEconomicEvents(rows as EconomicEvent[], at);
  if (automation.automated && automation.stale) {
    const result = {
      ...classified,
      status: "MANUAL_OVERRIDE" as NewsStatus,
      reason: `Economic calendar safety block: ${automation.reason}`,
      activeEvent: null,
      automation
    };
    eventStatusCache = { key: cacheKey, expiresAt: Date.now() + 30_000, value: result };
    return result;
  }
  const result = { ...classified, automation };
  eventStatusCache = { key: cacheKey, expiresAt: Date.now() + 30_000, value: result };
  return result;
}

export function invalidateEconomicEventStatusCache() {
  eventStatusCache = null;
}

export async function syncEconomicCalendar(input: {
  now?: Date;
  fetchImpl?: typeof fetch;
} = {}) {
  const provider = configuredCalendarProvider();
  if (provider === "MANUAL") return { provider, status: "MANUAL", imported: 0, skipped: true };
  if (provider !== OFFICIAL_US_PROVIDER) throw new Error(`Unsupported economic calendar provider: ${provider}`);
  const now = input.now ?? new Date();
  const coverageStart = startOfUtcDay(new Date(now.getTime() - 24 * 60 * 60_000));
  const ownsSync = await markSyncAttempt(provider);
  if (!ownsSync) return { provider, status: "ALREADY_RUNNING", imported: 0, skipped: true };
  try {
    const sources = await fetchOfficialUsCalendar(input.fetchImpl ?? fetch, now);
    if (sources.successful.length === 0) {
      throw new Error(`Every official economic calendar source failed: ${sourceFailureMessage(sources.failures)}`);
    }
    const events = sources.successful.flatMap((source) => source.events
      .filter((event) => new Date(event.eventTimeUtc) >= coverageStart)
      .map((event) => ({ ...event, sourceCode: source.sourceCode })));
    const coverageEnd = new Date(Math.min(...sources.successful.map((source) => new Date(source.coverageEndAt).getTime())));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        await client.query(
          `INSERT INTO economic_events (
             title, affected_currency, impact, event_time_utc,
             block_before_minutes, block_after_minutes, notes,
             provider, external_event_id, source_updated_at, last_seen_at, metadata
           ) VALUES ($1,'USD','HIGH',$2,$3,$4,$5,$6,$7,$8,$10,$9::jsonb)
           ON CONFLICT (provider, external_event_id) WHERE external_event_id IS NOT NULL
           DO UPDATE SET
             title = EXCLUDED.title,
             affected_currency = EXCLUDED.affected_currency,
             impact = EXCLUDED.impact,
             event_time_utc = EXCLUDED.event_time_utc,
             block_before_minutes = EXCLUDED.block_before_minutes,
             block_after_minutes = EXCLUDED.block_after_minutes,
             notes = EXCLUDED.notes,
             source_updated_at = EXCLUDED.source_updated_at,
             last_seen_at = EXCLUDED.last_seen_at,
             metadata = EXCLUDED.metadata`,
          [
            event.title,
            event.eventTimeUtc,
            config.economicCalendarBlockBeforeMinutes,
            config.economicCalendarBlockAfterMinutes,
            `Automatically synchronized from the official ${event.sourceCode} release schedule.`,
            provider,
            event.externalEventId,
            event.sourceUpdatedAt,
            JSON.stringify(event.metadata),
            now.toISOString()
          ]
        );
      }
      for (const source of sources.successful) {
        await client.query(
          `DELETE FROM economic_events
           WHERE provider = $1
             AND metadata->>'sourceCode' = $2
             AND event_time_utc BETWEEN $3 AND $4
             AND last_seen_at < $5
             AND override_status IS NULL`,
          [provider, source.sourceCode, coverageStart.toISOString(), source.coverageEndAt, now.toISOString()]
        );
      }
      const metadata = JSON.stringify({
        country: "United States",
        officialSources: sources.successful.map((source) => ({
          sourceCode: source.sourceCode,
          sourceUrl: source.sourceUrl,
          fetchedAt: source.fetchedAt,
          coverageEndAt: source.coverageEndAt,
          events: source.events.length
        })),
        failures: sources.failures
      });
      if (sources.failures.length === 0) {
        await client.query(
          `INSERT INTO economic_calendar_sync_state (
             provider, enabled, status, last_attempt_at, last_success_at,
             coverage_start_at, coverage_end_at, events_upserted, last_error, metadata, updated_at
           ) VALUES ($1,true,'HEALTHY',$2,$2,$3,$4,$5,NULL,$6::jsonb,now())
           ON CONFLICT (provider) DO UPDATE SET
             enabled = true, status = 'HEALTHY', last_attempt_at = EXCLUDED.last_attempt_at,
             last_success_at = EXCLUDED.last_success_at, coverage_start_at = EXCLUDED.coverage_start_at,
             coverage_end_at = EXCLUDED.coverage_end_at, events_upserted = EXCLUDED.events_upserted,
             last_error = NULL, metadata = EXCLUDED.metadata, updated_at = now()`,
          [provider, now.toISOString(), coverageStart.toISOString(), coverageEnd.toISOString(), events.length, metadata]
        );
      } else {
        await client.query(
          `INSERT INTO economic_calendar_sync_state (
             provider, enabled, status, last_attempt_at, events_upserted, last_error, metadata, updated_at
           ) VALUES ($1,true,'ERROR',$2,$3,$4,$5::jsonb,now())
           ON CONFLICT (provider) DO UPDATE SET
             enabled = true, status = 'ERROR', last_attempt_at = EXCLUDED.last_attempt_at,
             events_upserted = EXCLUDED.events_upserted, last_error = EXCLUDED.last_error,
             metadata = EXCLUDED.metadata, updated_at = now()`,
          [provider, now.toISOString(), events.length, sourceFailureMessage(sources.failures), metadata]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (sources.failures.length > 0) {
      throw new Error(`Official economic calendar synchronization was incomplete: ${sourceFailureMessage(sources.failures)}`);
    }
    await recordOperationalEvent({
      category: "SYSTEM",
      eventType: "ECONOMIC_CALENDAR_SYNC_SUCCEEDED",
      source: "economic-calendar-worker",
      message: `Economic calendar synchronized ${events.length} high-impact US event(s) from four official sources.`,
      metadata: { provider, coverageStart: coverageStart.toISOString(), coverageEnd: coverageEnd.toISOString(), events: events.length, sources: sources.successful.map((source) => source.sourceCode) }
    });
    invalidateEconomicEventStatusCache();
    return { provider, status: "HEALTHY", imported: events.length, coverageStart: coverageStart.toISOString(), coverageEnd: coverageEnd.toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordSyncFailure(provider, message);
    await recordOperationalEvent({
      severity: "ERROR",
      category: "SYSTEM",
      eventType: "ECONOMIC_CALENDAR_SYNC_FAILED",
      source: "economic-calendar-worker",
      message: `Economic calendar synchronization failed: ${message}`,
      metadata: { provider }
    });
    throw error;
  }
}

export function startEconomicCalendarWorker() {
  if (configuredCalendarProvider() === "MANUAL") return null;
  const run = () => syncEconomicCalendar().catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      service: "economic-calendar-worker",
      message: "Economic calendar synchronization failed.",
      error: error instanceof Error ? error.message : String(error)
    }));
  });
  const startupTimer = setTimeout(run, 15_000);
  const intervalTimer = setInterval(run, config.economicCalendarSyncMinutes * 60_000);
  return { startupTimer, intervalTimer };
}

function configuredCalendarProvider() {
  return config.economicCalendarProvider === "official_us" ? OFFICIAL_US_PROVIDER : "MANUAL";
}

async function upcomingEventCount(at: Date) {
  const { rows } = await query(
    `SELECT count(*)::int AS count
     FROM economic_events
     WHERE affected_currency IN ('USD', 'XAU', 'ALL')
       AND upper(impact) IN ('HIGH', 'CRITICAL')
       AND event_time_utc >= $1
       AND event_time_utc <= $1::timestamptz + interval '14 days'`,
    [at.toISOString()]
  );
  return Number(rows[0]?.count ?? 0);
}

async function markSyncAttempt(provider: string) {
  const result = await query(
    `INSERT INTO economic_calendar_sync_state (provider, enabled, status, last_attempt_at, updated_at)
     VALUES ($1,true,'RUNNING',now(),now())
     ON CONFLICT (provider) DO UPDATE SET enabled = true, status = 'RUNNING', last_attempt_at = now(), updated_at = now()
     WHERE economic_calendar_sync_state.status <> 'RUNNING'
        OR economic_calendar_sync_state.last_attempt_at < now() - interval '10 minutes'
     RETURNING provider`,
    [provider]
  );
  return (result.rowCount ?? 0) > 0;
}

async function recordSyncFailure(provider: string, message: string) {
  await query(
    `INSERT INTO economic_calendar_sync_state (provider, enabled, status, last_attempt_at, last_error, updated_at)
     VALUES ($1,true,'ERROR',now(),$2,now())
     ON CONFLICT (provider) DO UPDATE SET enabled = true, status = 'ERROR', last_attempt_at = now(), last_error = EXCLUDED.last_error, updated_at = now()`,
    [provider, message.slice(0, 1_000)]
  ).catch(() => undefined);
}

function startOfUtcDay(value: Date) {
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function sourceFailureMessage(failures: Array<{ sourceCode: string; error: string }>) {
  return failures.map((failure) => `${failure.sourceCode}: ${failure.error}`).join("; ").slice(0, 1_000);
}
