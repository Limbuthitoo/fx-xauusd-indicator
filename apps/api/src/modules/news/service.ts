import type { NewsStatus } from "@orb-guide/shared-types";
import { query } from "../../infrastructure/db/client.js";

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
};

export type EconomicEventState = {
  status: NewsStatus;
  reason: string;
  activeEvent: EconomicEvent | null;
  events: EconomicEvent[];
  evaluatedAt: string;
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

export async function economicEventStatus(evaluatedAt: string | Date = new Date()) {
  const at = new Date(evaluatedAt);
  const { rows } = await query(
    `SELECT *
     FROM economic_events
     WHERE affected_currency IN ('USD', 'XAU', 'ALL')
       AND upper(impact) IN ('HIGH', 'CRITICAL')
       AND event_time_utc >= $1::timestamptz - interval '4 hours'
       AND event_time_utc <= $1::timestamptz + interval '24 hours'
     ORDER BY event_time_utc ASC`,
    [at.toISOString()]
  );
  return classifyEconomicEvents(rows as EconomicEvent[], at);
}
