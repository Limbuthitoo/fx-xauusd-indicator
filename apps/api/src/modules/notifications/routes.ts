import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { requirePermission } from "../auth/routes.js";

export async function notificationRoutes(app: FastifyInstance) {
  app.get("/api/notifications", async (request) => {
    const session = requirePermission(request, "notifications.manage");
    const search = request.query as { unacknowledged?: string; limit?: string; moduleCode?: string; priority?: string; eventType?: string; dateFrom?: string; dateTo?: string };
    const limit = Math.min(Number(search.limit ?? 30), 100);
    const onlyUnacknowledged = search.unacknowledged === "true";
    const moduleCode = search.moduleCode ?? "";
    const moduleFilter = notificationModulePrefix(moduleCode);
    const priority = search.priority ? search.priority.toUpperCase() : "";
    const eventType = search.eventType ? search.eventType.toUpperCase() : "";
    const dateFrom = search.dateFrom ? new Date(search.dateFrom).toISOString() : null;
    const dateTo = search.dateTo ? new Date(search.dateTo).toISOString() : null;
    const { rows } = await query(
      `SELECT *
       FROM notifications
       WHERE tenant_id = $3
         AND ($1::boolean = false OR acknowledged_at IS NULL)
         AND (
           $4 = ''
           OR event_type LIKE ($4 || '%')
           OR ($4 = 'MODULE1' AND event_type LIKE 'ORB%')
           OR title ILIKE ('%' || $4 || '%')
           OR body ILIKE ('%' || $4 || '%')
         )
         AND ($5 = '' OR priority = $5)
         AND ($6 = '' OR event_type = $6)
         AND ($7::timestamptz IS NULL OR created_at >= $7::timestamptz)
         AND ($8::timestamptz IS NULL OR created_at <= $8::timestamptz)
       ORDER BY created_at DESC
       LIMIT $2`,
      [onlyUnacknowledged, limit, session.tenantId, moduleFilter, priority, eventType, dateFrom, dateTo]
    );
    return rows;
  });

  app.get("/api/notifications/summary", async (request) => {
    const session = requirePermission(request, "notifications.manage");
    const rows = await query(
      `SELECT *
       FROM notifications
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT 300`,
      [session.tenantId]
    );
    const modules = [
      { moduleCode: "orb_max_options", moduleName: "Module 1 ORB", prefixes: ["MODULE1", "ORB"] },
      { moduleCode: "high_probability_strategy_2", moduleName: "Module 2 Ultimate Sweep", prefixes: ["MODULE2"] }
    ];
    return modules.map((module) => {
      const items = rows.rows.filter((item: any) => notificationBelongsToModule(item, module.prefixes));
      const eventKeys = new Set(items.map((item: any) => item.event_key).filter(Boolean));
      return {
        moduleCode: module.moduleCode,
        moduleName: module.moduleName,
        total: items.length,
        unread: items.filter((item: any) => !item.acknowledged_at).length,
        highPriority: items.filter((item: any) => ["CRITICAL", "HIGH"].includes(item.priority)).length,
        signalAlerts: items.filter((item: any) => /SIGNAL|SETUP_READY|REPLAY/.test(item.event_type ?? "")).length,
        paperTradeAlerts: items.filter((item: any) => /ENTRY|TP_HIT|SL_HIT|PAPER|TRADE/.test(item.event_type ?? "")).length,
        rehearsalAlerts: items.filter((item: any) => /REHEARSAL/.test(item.event_type ?? "")).length,
        lifecycleAlerts: items.filter((item: any) => /CLOSE|CLOSEOUT|REPORT|EXPIRED/.test(item.event_type ?? "")).length,
        duplicateProtected: items.length === eventKeys.size,
        duplicateCount: items.length - eventKeys.size,
        latest: items[0] ?? null
      };
    });
  });

  app.post("/api/notifications/:id/ack", async (request) => {
    const session = requirePermission(request, "notifications.manage");
    const { id } = request.params as { id: string };
    const { rows } = await query("UPDATE notifications SET acknowledged_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *", [id, session.tenantId]);
    return rows[0];
  });
}

function notificationModulePrefix(moduleCode: string) {
  if (moduleCode === "high_probability_strategy_2") return "MODULE2";
  if (moduleCode === "orb_max_options") return "MODULE1";
  return "";
}

function notificationBelongsToModule(item: any, prefixes: string[]) {
  const haystack = `${item.event_type ?? ""} ${item.title ?? ""} ${item.body ?? ""}`;
  return prefixes.some((prefix) => haystack.includes(prefix) || haystack.includes(prefix.replace("MODULE", "Module ")));
}
