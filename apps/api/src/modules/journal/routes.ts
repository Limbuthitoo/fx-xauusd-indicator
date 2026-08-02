import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { requireTenantModule } from "../auth/routes.js";

export async function journalRoutes(app: FastifyInstance) {
  app.post("/api/journal", async (request) => {
    const body = request.body as any;
    const moduleCode = await journalModuleCode(body);
    const session = await requireTenantModule(request, moduleCode);
    if (body.sessionId && !(await belongsToTenant("trading_sessions", body.sessionId, session.tenantId))) return { error: "Session not found" };
    if (body.setupCandidateId && !(await belongsToTenant("setup_candidates", body.setupCandidateId, session.tenantId))) return { error: "Setup not found" };
    if (body.tradeId && !(await tradeBelongsToTenant(body.tradeId, session.tenantId))) return { error: "Trade not found" };
    const { rows } = await query(
      `INSERT INTO journal_entries (
        tenant_id, setup_candidate_id, trade_id, session_id, decision, emotion_before, confidence,
        sleep_readiness, revenge_trading_risk, fear_of_missing_out, rule_violations,
        emotion_after, lesson, process_grade, outcome
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        session.tenantId,
        body.setupCandidateId ?? null,
        body.tradeId ?? null,
        body.sessionId ?? null,
        body.decision,
        body.emotionBefore ?? null,
        body.confidence ?? null,
        body.sleepReadiness ?? null,
        body.revengeTradingRisk ?? null,
        body.fearOfMissingOut ?? null,
        body.ruleViolations ?? null,
        body.emotionAfter ?? null,
        body.lesson ?? null,
        body.processGrade ?? null,
        body.outcome ?? null
      ]
    );
    return rows[0];
  });

  app.get("/api/journal", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const session = await requireTenantModule(request, moduleCode);
    const { rows } = await query(
      `SELECT je.*
       FROM journal_entries je
       LEFT JOIN trading_sessions ts ON ts.id = je.session_id
       LEFT JOIN setup_candidates sc ON sc.id = je.setup_candidate_id
       WHERE je.tenant_id = $1
         AND COALESCE(ts.module_code, sc.module_code, $2) = $2
       ORDER BY je.created_at DESC
       LIMIT 100`,
      [session.tenantId, moduleCode]
    );
    return rows;
  });

  app.get("/api/journal/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scoped = await journalEntryScope(id);
    if (!scoped) return reply.code(404).send({ message: "Journal entry not found" });
    const session = await requireTenantModule(request, scoped.moduleCode);
    const { rows } = await query("SELECT * FROM journal_entries WHERE id = $1 AND tenant_id = $2", [id, session.tenantId]);
    if (!rows[0]) return reply.code(404).send({ message: "Journal entry not found" });
    return rows[0];
  });

  app.put("/api/journal/:id", async (request) => {
    const { id } = request.params as { id: string };
    const scoped = await journalEntryScope(id);
    if (!scoped) return null;
    const session = await requireTenantModule(request, scoped.moduleCode);
    const body = request.body as any;
    const { rows } = await query(
      "UPDATE journal_entries SET lesson = COALESCE($2, lesson), process_grade = COALESCE($3, process_grade), outcome = COALESCE($4, outcome) WHERE id = $1 AND tenant_id = $5 RETURNING *",
      [id, body.lesson, body.processGrade, body.outcome, session.tenantId]
    );
    return rows[0];
  });
}

async function journalModuleCode(body: any) {
  if (body.setupCandidateId) {
    const setup = await query("SELECT module_code FROM setup_candidates WHERE id = $1", [body.setupCandidateId]);
    if (setup.rows[0]?.module_code) return setup.rows[0].module_code;
  }
  if (body.sessionId) {
    const session = await query("SELECT module_code FROM trading_sessions WHERE id = $1", [body.sessionId]);
    if (session.rows[0]?.module_code) return session.rows[0].module_code;
  }
  return body.moduleCode ?? "orb_max_options";
}

async function journalEntryScope(id: string) {
  const { rows } = await query(
    `SELECT je.tenant_id, COALESCE(ts.module_code, sc.module_code, 'orb_max_options') AS module_code
     FROM journal_entries je
     LEFT JOIN trading_sessions ts ON ts.id = je.session_id
     LEFT JOIN setup_candidates sc ON sc.id = je.setup_candidate_id
     WHERE je.id = $1`,
    [id]
  );
  const row = rows[0] as any;
  return row ? { tenantId: row.tenant_id, moduleCode: row.module_code } : null;
}

async function belongsToTenant(table: "trading_sessions" | "setup_candidates", id: string, tenantId: string | null) {
  const { rows } = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return Boolean(rows[0]);
}

async function tradeBelongsToTenant(id: string, tenantId: string | null) {
  const { rows } = await query(
    `SELECT 1
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE t.id = $1 AND sc.tenant_id = $2`,
    [id, tenantId]
  );
  return Boolean(rows[0]);
}
