import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";

export async function newsRoutes(app: FastifyInstance) {
  app.get("/api/news/events", async () => {
    const { rows } = await query("SELECT * FROM economic_events ORDER BY event_time_utc DESC LIMIT 100");
    return rows;
  });

  app.post("/api/news/events", async (request) => {
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
        body.blockBeforeMinutes ?? 30,
        body.blockAfterMinutes ?? 30,
        body.notes ?? null
      ]
    );
    return rows[0];
  });

  app.get("/api/news/status", async () => {
    const now = new Date();
    const { rows } = await query(
      `SELECT *
       FROM economic_events
       WHERE affected_currency IN ('USD', 'XAU', 'ALL')
         AND event_time_utc >= now() - interval '4 hours'
         AND event_time_utc <= now() + interval '24 hours'
       ORDER BY event_time_utc ASC`
    );
    let status = "CLEAR";
    let activeEvent = null;
    for (const event of rows as any[]) {
      const eventTime = new Date(event.event_time_utc);
      const before = new Date(eventTime.getTime() - Number(event.block_before_minutes) * 60_000);
      const after = new Date(eventTime.getTime() + Number(event.block_after_minutes) * 60_000);
      if (now >= before && now < eventTime) {
        status = "BLOCKED_BEFORE_EVENT";
        activeEvent = event;
        break;
      }
      if (now >= eventTime && now <= after) {
        status = "BLOCKED_AFTER_EVENT";
        activeEvent = event;
        break;
      }
      if (eventTime.getTime() - now.getTime() <= 60 * 60_000 && eventTime > now) {
        status = "UPCOMING_WARNING";
        activeEvent = event;
      }
    }
    return { status, activeEvent, events: rows };
  });
}
