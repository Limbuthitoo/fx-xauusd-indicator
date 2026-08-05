import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { requirePermission } from "../auth/routes.js";

const MODULE_CODE = "high_probability_strategy_2";

export async function coreEngineRoutes(app: FastifyInstance) {
  app.get("/api/liquidity/active", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return [];
    const rows = await query(
      `SELECT *
       FROM liquidity_levels
       WHERE tenant_id = $1
         AND module_code = $2
         AND state IN ('ACTIVE','APPROACHING','TOUCHED','PARTIALLY_SWEPT','SWEPT','RECLAIMED')
       ORDER BY quality_score DESC, confirmed_at DESC
       LIMIT 200`,
      [auth.tenantId, MODULE_CODE]
    );
    return rows.rows;
  });

  app.get("/api/liquidity/history", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return [];
    const search = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(search.limit ?? 200), 1), 500);
    const rows = await query(
      `SELECT *
       FROM liquidity_levels
       WHERE tenant_id = $1
         AND module_code = $2
       ORDER BY confirmed_at DESC
       LIMIT $3`,
      [auth.tenantId, MODULE_CODE, limit]
    );
    return rows.rows;
  });

  app.get("/api/liquidity/:id", async (request, reply) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return reply.code(404).send({ message: "Not found." });
    const { id } = request.params as { id: string };
    const row = await query("SELECT * FROM liquidity_levels WHERE id = $1 AND tenant_id = $2", [id, auth.tenantId]);
    if (!row.rows[0]) return reply.code(404).send({ message: "Liquidity level not found." });
    const events = await query("SELECT * FROM liquidity_level_events WHERE liquidity_level_id = $1 ORDER BY occurred_at DESC LIMIT 100", [id]);
    return { ...row.rows[0], events: events.rows };
  });

  app.post("/api/liquidity/:id/retire", async (request, reply) => {
    const auth = requirePermission(request, "settings.manage");
    if (!auth.tenantId) return reply.code(404).send({ message: "Not found." });
    const { id } = request.params as { id: string };
    const before = await query("SELECT * FROM liquidity_levels WHERE id = $1 AND tenant_id = $2", [id, auth.tenantId]);
    if (!before.rows[0]) return reply.code(404).send({ message: "Liquidity level not found." });
    const updated = await query("UPDATE liquidity_levels SET state = 'RETIRED', updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *", [id, auth.tenantId]);
    await query(
      `INSERT INTO liquidity_level_events (liquidity_level_id, tenant_id, module_code, event_type, previous_state, next_state, payload)
       VALUES ($1,$2,$3,'MANUAL_RETIRE',$4,'RETIRED',$5::jsonb)`,
      [id, auth.tenantId, MODULE_CODE, before.rows[0].state, JSON.stringify({ reason: "User retired liquidity level." })]
    );
    return updated.rows[0];
  });

  app.get("/api/structure/current", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return { points: [], breaks: [] };
    const points = await query(
      `SELECT *
       FROM structure_points
       WHERE tenant_id = $1 AND module_code = $2
       ORDER BY confirmed_at DESC
       LIMIT 60`,
      [auth.tenantId, MODULE_CODE]
    );
    const breaks = await query(
      `SELECT *
       FROM structure_break_events
       WHERE tenant_id = $1 AND module_code = $2
       ORDER BY occurred_at DESC
       LIMIT 30`,
      [auth.tenantId, MODULE_CODE]
    );
    return { points: points.rows, breaks: breaks.rows };
  });

  app.get("/api/structure/history", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return [];
    const rows = await query("SELECT * FROM structure_points WHERE tenant_id = $1 AND module_code = $2 ORDER BY confirmed_at DESC LIMIT 300", [auth.tenantId, MODULE_CODE]);
    return rows.rows;
  });

  app.get("/api/structure/breaks", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return [];
    const rows = await query("SELECT * FROM structure_break_events WHERE tenant_id = $1 AND module_code = $2 ORDER BY occurred_at DESC LIMIT 200", [auth.tenantId, MODULE_CODE]);
    return rows.rows;
  });

  app.get("/api/market-regime/current", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return null;
    const row = await query(
      `SELECT *
       FROM market_regimes
       WHERE tenant_id = $1 AND module_code = $2
       ORDER BY candle_timestamp DESC
       LIMIT 1`,
      [auth.tenantId, MODULE_CODE]
    );
    return row.rows[0] ?? null;
  });

  app.get("/api/market-regime/history", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return [];
    const rows = await query("SELECT * FROM market_regimes WHERE tenant_id = $1 AND module_code = $2 ORDER BY candle_timestamp DESC LIMIT 300", [auth.tenantId, MODULE_CODE]);
    return rows.rows;
  });

  app.get("/api/positions/current", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return [];
    const rows = await query(
      `SELECT *
       FROM positions
       WHERE tenant_id = $1
         AND state IN ('PLANNED','PENDING_MANUAL_EXECUTION','OPEN','PARTIALLY_CLOSED','BREAK_EVEN','TRAILING','RECONCILIATION_REQUIRED')
       ORDER BY created_at DESC`,
      [auth.tenantId]
    );
    return rows.rows;
  });

  app.get("/api/positions/history", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return [];
    const rows = await query("SELECT * FROM positions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 300", [auth.tenantId]);
    return rows.rows;
  });

  app.post("/api/positions/open-manual", async (request) => {
    const auth = requirePermission(request, "signals.view");
    const body = request.body as Record<string, unknown>;
    const direction = String(body.direction ?? "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
    const plannedEntry = Number(body.plannedEntry ?? body.actualEntry);
    const stop = Number(body.initialStop ?? body.currentStop);
    const target = Number(body.initialTarget);
    const inserted = await query(
      `INSERT INTO positions (tenant_id, trade_plan_id, symbol, direction, planned_entry, actual_entry, initial_stop, current_stop, initial_target, quantity, state, opened_at, metadata)
       VALUES ($1,$2,'XAUUSD',$3,$4,$5,$6,$6,$7,$8,'OPEN',now(),$9::jsonb)
       RETURNING *`,
      [auth.tenantId, body.tradePlanId ?? null, direction, plannedEntry, Number(body.actualEntry ?? plannedEntry), stop, target, Number(body.quantity ?? 1), JSON.stringify({ source: "MANUAL_EXECUTION" })]
    );
    return inserted.rows[0];
  });

  app.put("/api/positions/:id", async (request, reply) => {
    const auth = requirePermission(request, "signals.view");
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const currentStop = Number(body.currentStop);
    const state = String(body.state ?? "OPEN");
    const updated = await query(
      `UPDATE positions
       SET current_stop = CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE current_stop END,
           state = $4,
           metadata = metadata || $5::jsonb
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, auth.tenantId, Number.isFinite(currentStop) ? currentStop : 0, state, JSON.stringify({ lastManualUpdateAt: new Date().toISOString() })]
    );
    if (!updated.rows[0]) return reply.code(404).send({ message: "Position not found." });
    return updated.rows[0];
  });

  app.post("/api/positions/:id/close", async (request, reply) => {
    const auth = requirePermission(request, "signals.view");
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const exit = Number(body.actualExit);
    const updated = await query(
      `UPDATE positions
       SET actual_exit = $3,
           state = $4,
           closed_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, auth.tenantId, exit, String(body.state ?? "CLOSED_BREAKEVEN")]
    );
    if (!updated.rows[0]) return reply.code(404).send({ message: "Position not found." });
    return updated.rows[0];
  });

  app.post("/api/replays", async (request) => {
    const auth = requirePermission(request, "signals.view");
    const body = request.body as Record<string, unknown>;
    const inserted = await query(
      `INSERT INTO replay_runs (tenant_id, module_code, strategy_version, status, controls, state)
       VALUES ($1,$2,$3,'DRAFT',$4::jsonb,$5::jsonb)
       RETURNING *`,
      [auth.tenantId, String(body.moduleCode ?? MODULE_CODE), String(body.strategyVersion ?? "ULTIMATE_LIQUIDITY_SWEEP_V1.0"), JSON.stringify({ speed: body.speed ?? 1 }), JSON.stringify({ cursor: null })]
    );
    return inserted.rows[0];
  });

  app.post("/api/replays/:id/step", replayControl("STEP_CANDLE"));
  app.post("/api/replays/:id/play", replayControl("PLAY"));
  app.post("/api/replays/:id/pause", replayControl("PAUSE"));

  app.get("/api/replays/:id/state", async (request, reply) => {
    const auth = requirePermission(request, "signals.view");
    const { id } = request.params as { id: string };
    const row = await query("SELECT * FROM replay_runs WHERE id = $1 AND tenant_id = $2", [id, auth.tenantId]);
    if (!row.rows[0]) return reply.code(404).send({ message: "Replay not found." });
    return row.rows[0];
  });

  app.post("/api/experiments", async (request) => {
    const auth = requirePermission(request, "signals.view");
    const body = request.body as Record<string, unknown>;
    const inserted = await query(
      `INSERT INTO parameter_experiments (tenant_id, module_code, parameter_changes, dataset_id, status)
       VALUES ($1,$2,$3::jsonb,$4,'DRAFT')
       RETURNING *`,
      [auth.tenantId, String(body.moduleCode ?? MODULE_CODE), JSON.stringify(body.parameterChanges ?? {}), body.datasetId ?? null]
    );
    return inserted.rows[0];
  });

  app.get("/api/experiments", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return [];
    const rows = await query("SELECT * FROM parameter_experiments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200", [auth.tenantId]);
    return rows.rows;
  });

  app.get("/api/experiments/:id", async (request, reply) => {
    const auth = requirePermission(request, "signals.view");
    const { id } = request.params as { id: string };
    const row = await query("SELECT * FROM parameter_experiments WHERE id = $1 AND tenant_id = $2", [id, auth.tenantId]);
    if (!row.rows[0]) return reply.code(404).send({ message: "Experiment not found." });
    return row.rows[0];
  });

  app.post("/api/experiments/:id/run", experimentStatus("RUNNING"));
  app.post("/api/experiments/:id/promote-candidate", experimentStatus("PROMOTED"));
}

function replayControl(control: string) {
  return async (request: any, reply: any) => {
    const auth = requirePermission(request, "signals.view");
    const { id } = request.params as { id: string };
    const status = control === "PLAY" ? "RUNNING" : control === "PAUSE" ? "PAUSED" : "STEPPED";
    const updated = await query(
      `UPDATE replay_runs
       SET status = $3,
           controls = controls || $4::jsonb
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, auth.tenantId, status, JSON.stringify({ lastControl: control, lastControlAt: new Date().toISOString() })]
    );
    if (!updated.rows[0]) return reply.code(404).send({ message: "Replay not found." });
    return updated.rows[0];
  };
}

function experimentStatus(status: string) {
  return async (request: any, reply: any) => {
    const auth = requirePermission(request, "signals.view");
    const { id } = request.params as { id: string };
    const updated = await query(
      `UPDATE parameter_experiments
       SET status = $3,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, auth.tenantId, status]
    );
    if (!updated.rows[0]) return reply.code(404).send({ message: "Experiment not found." });
    return updated.rows[0];
  };
}
