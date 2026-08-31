import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { requireAdmin } from "../auth/routes.js";

export async function strategyRoutes(app: FastifyInstance) {
  app.get("/api/strategies", async (request) => {
    const session = requireAdmin(request);
    const params: unknown[] = [];
    const tenantFilter = session.platformSuperAdmin
      ? ""
      : `WHERE EXISTS (
           SELECT 1
           FROM strategy_versions access_version
           JOIN tenant_modules tenant_module ON tenant_module.tenant_id = $1 AND tenant_module.status = 'ENABLED'
           JOIN platform_strategy_modules module ON module.id = tenant_module.module_id AND module.status = 'ACTIVE'
           LEFT JOIN strategy_sources source ON source.id = s.source_id
           WHERE access_version.strategy_id = s.id
             AND COALESCE(access_version.configuration_json->>'moduleCode', source.metadata->>'moduleCode', 'orb_max_options') = module.code
         )`;
    if (!session.platformSuperAdmin) params.push(session.tenantId);
    const { rows } = await query(`
      SELECT s.*, COALESCE(json_agg(sv.*) FILTER (WHERE sv.id IS NOT NULL), '[]') AS versions
      FROM strategies s
      LEFT JOIN strategy_versions sv ON sv.strategy_id = s.id AND sv.status <> 'RETIRED'
      ${tenantFilter}
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `, params);
    return rows;
  });

  app.get("/api/strategies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { rows } = await query("SELECT * FROM strategies WHERE id = $1", [id]);
    if (!rows[0]) return reply.code(404).send({ message: "Strategy not found" });
    return rows[0];
  });

  app.post("/api/strategies/:id/versions", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { version: string; configuration: Record<string, unknown> };
    const { rows } = await query(
      `INSERT INTO strategy_versions (
        strategy_id, version, status, session_start, trade_window_end,
        opening_range_minutes, signal_timeframe_minutes, configuration_json
      ) VALUES ($1, $2, 'RESEARCH', $3, $4, $5, $6, $7) RETURNING *`,
      [
        id,
        body.version,
        body.configuration.sessionStart,
        body.configuration.tradeWindowEnd,
        body.configuration.openingRangeMinutes,
        body.configuration.signalTimeframeMinutes,
        body.configuration
      ]
    );
    return rows[0];
  });

  app.post("/api/strategy-versions/:id/activate", async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await query("UPDATE strategy_versions SET status = 'ACTIVE', activated_at = now() WHERE id = $1 RETURNING *", [id]);
    return rows[0];
  });

  app.post("/api/strategy-versions/:id/retire", async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await query("UPDATE strategy_versions SET status = 'RETIRED', retired_at = now() WHERE id = $1 RETURNING *", [id]);
    return rows[0];
  });

  app.post("/api/strategy-versions/:id/clone", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { version: string };
    const { rows } = await query(
      `INSERT INTO strategy_versions (
        strategy_id, version, status, session_start, trade_window_end,
        opening_range_minutes, signal_timeframe_minutes, configuration_json
      )
      SELECT strategy_id, $2, 'RESEARCH', session_start, trade_window_end,
        opening_range_minutes, signal_timeframe_minutes, configuration_json
      FROM strategy_versions
      WHERE id = $1
      RETURNING *`,
      [id, body.version]
    );
    return rows[0];
  });
}
