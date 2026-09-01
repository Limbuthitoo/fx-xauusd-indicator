import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { requirePermission } from "../auth/routes.js";
import { economicCalendarAutomationStatus, economicEventStatus, invalidateEconomicEventStatusCache, syncEconomicCalendar } from "./service.js";

export async function newsRoutes(app: FastifyInstance) {
  app.get("/api/news/events", async () => {
    const { rows } = await query("SELECT * FROM economic_events ORDER BY event_time_utc DESC LIMIT 100");
    return rows;
  });

  app.get("/api/news/automation", async (request) => {
    requirePermission(request, "signals.view");
    return economicCalendarAutomationStatus();
  });

  app.post("/api/news/sync", async (request) => {
    requirePermission(request, "settings.manage");
    return syncEconomicCalendar();
  });

  app.post("/api/news/events", async (request) => {
    requirePermission(request, "settings.manage");
    const body = request.body as {
      title: string;
      affectedCurrency?: string;
      impact?: string;
      eventTimeUtc: string;
      blockBeforeMinutes?: number;
      blockAfterMinutes?: number;
      notes?: string;
    };
    const { rows } = await query(
      `INSERT INTO economic_events (
        title, affected_currency, impact, event_time_utc, block_before_minutes, block_after_minutes, notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        body.title,
        body.affectedCurrency ?? "USD",
        body.impact ?? "HIGH",
        body.eventTimeUtc,
        Math.max(0, Math.min(Number(body.blockBeforeMinutes ?? 30), 240)),
        Math.max(0, Math.min(Number(body.blockAfterMinutes ?? 30), 240)),
        body.notes ?? null
      ]
    );
    invalidateEconomicEventStatusCache();
    return rows[0];
  });

  app.get("/api/news/status", async () => {
    return economicEventStatus();
  });
}
