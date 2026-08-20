import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { newYorkDate } from "../../infrastructure/time.js";
import { requirePermission, requireTenantModule } from "../auth/routes.js";
import { cancelPendingPaperTargets, ensurePaperTradeTargets, evaluatePaperTargetMilestones, paperTradeSettlement } from "./paper-targets.js";

export async function tradeRoutes(app: FastifyInstance) {
  app.get("/api/trades/paper", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return { summary: emptyPaperTradeSummary(), trades: [] };
    const search = request.query as { limit?: string; status?: string; moduleCode?: string; includeProof?: string };
    const limit = Math.min(Math.max(Number(search.limit ?? 200), 1), 500);
    const status = String(search.status ?? "ALL").toUpperCase();
    const moduleCode = String(search.moduleCode ?? "ALL");
    const includeProof = search.includeProof === "true";
    await settleOpenPaperTrades(auth.tenantId, moduleCode, includeProof);
    const params: unknown[] = [auth.tenantId];
    const statusFilter = status !== "ALL" ? `AND t.outcome = $${params.push(status)}` : "";
    const moduleFilter = moduleCode !== "ALL" ? `AND sc.module_code = $${params.push(moduleCode)}` : "";
    const productionFilter = includeProof
      ? ""
      : `AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'`;
    params.push(limit);
    const { rows } = await query(
      `SELECT
         t.id,
         t.outcome,
         t.actual_entry,
         t.actual_stop,
         t.actual_target,
         t.actual_exit,
         t.actual_lot,
         t.result_r,
         t.structural_stop,
         t.realized_r,
         t.remaining_fraction,
         t.breakeven_activated_at,
         t.max_favorable_excursion_r,
         t.max_adverse_excursion_r,
         t.result_money,
         t.opened_at,
         t.closed_at,
         tp.reward_to_risk,
         tp.planned_risk_amount,
         sc.id AS setup_candidate_id,
         sc.symbol,
         sc.direction,
         sc.scenario,
         sc.module_code,
         sc.favorability_grade,
         sc.favorability_score,
         sc.final_reason,
         target_progress.targets,
         latest.close AS current_price,
         latest.timestamp_utc AS current_price_at
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       JOIN platform_strategy_modules sm ON sm.code = sc.module_code
       JOIN tenant_modules tm ON tm.module_id = sm.id
         AND tm.tenant_id = sc.tenant_id
         AND tm.status = 'ENABLED'
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'targetNumber', ptt.target_number,
           'price', ptt.price,
           'riskMultiple', ptt.risk_multiple,
           'positionFraction', ptt.position_fraction,
           'realizedR', ptt.realized_r,
           'status', ptt.status,
           'hitAt', ptt.hit_at,
           'hitPrice', ptt.hit_price
         ) ORDER BY ptt.target_number) AS targets
         FROM paper_trade_targets ptt
         WHERE ptt.trade_id = t.id
       ) target_progress ON true
       LEFT JOIN LATERAL (
         SELECT c.close, c.timestamp_utc
         FROM candles c
         WHERE c.symbol = sc.symbol
           AND c.timeframe_minutes = 5
           AND c.source LIKE 'TWELVE_DATA%'
         ORDER BY c.timestamp_utc DESC
         LIMIT 1
       ) latest ON true
       WHERE sc.tenant_id = $1
         ${statusFilter}
         ${moduleFilter}
         ${productionFilter}
       ORDER BY CASE WHEN t.outcome = 'ACTIVE' THEN 0 ELSE 1 END,
         COALESCE(t.opened_at, t.closed_at) DESC
       LIMIT $${params.length}`,
      params
    );
    const trades = rows.map(paperTradeView);
    return { summary: summarizePaperTrades(trades), trades };
  });

  app.post("/api/trades/recover-stale", async (request) => {
    const search = request.query as { moduleCode?: string };
    const body = request.body as { olderThanHours?: number };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const olderThanHours = Math.max(1, Math.min(Number(body.olderThanHours ?? 6), 48));
    const timeframe = moduleExecutionTimeframeMinutes(moduleCode);
    const active = await query(
      `SELECT
         t.*,
         tp.id AS trade_plan_id,
         tp.setup_candidate_id,
         sc.tenant_id,
         sc.session_id,
         sc.symbol,
         sc.direction,
         sc.scenario,
         sc.module_code
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND t.outcome = 'ACTIVE'
         AND t.opened_at < now() - ($3::text || ' hours')::interval
       ORDER BY t.opened_at ASC`,
      [auth.tenantId, moduleCode, olderThanHours]
    );
    const recovered = [];
    for (const trade of active.rows as any[]) {
      const candles = await query(
        `SELECT timestamp_utc, open, high, low, close
         FROM candles
         WHERE symbol = $1
           AND timeframe_minutes = $2
           AND timestamp_utc >= $3
         ORDER BY timestamp_utc ASC`,
        [trade.symbol, timeframe, trade.opened_at]
      );
      let exit = null as any;
      for (const candle of candles.rows as any[]) {
        const progress = await evaluatePaperTargetMilestones(trade, candle);
        if (progress.stopHit) {
          exit = { reason: progress.stopReason ?? "STOP", price: progress.stopPrice, timestampUtc: candle.timestamp_utc, candle, ambiguous: progress.ambiguous };
          break;
        }
        if (progress.finalTargetHit) {
          exit = { reason: "TARGET", price: Number(trade.actual_target), timestampUtc: candle.timestamp_utc, candle, ambiguous: false };
          break;
        }
      }
      if (!exit) continue;
      const settlement = await paperTradeSettlement(trade, exit.price);
      const { resultR, outcome } = settlement;
      const updated = await query(
        `UPDATE trades SET
           actual_exit = $2,
           result_r = $3,
           outcome = $4,
           closed_at = $5,
           remaining_fraction = 0
         WHERE id = $1
         RETURNING *`,
        [trade.id, exit.price, resultR, outcome, exit.timestampUtc]
      );
      await cancelPendingPaperTargets(trade.id, exit.reason);
      await query("UPDATE trade_plans SET status = 'CLOSED' WHERE id = $1", [trade.trade_plan_id]);
      await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,'PAPER_RECOVERY_CLOSE',$2)", [
        trade.id,
        { mode: "PAPER", moduleCode, exitReason: exit.reason, candle: exit.candle, recoveredAt: new Date().toISOString() }
      ]);
      await query(
        `INSERT INTO journal_entries (
          tenant_id, setup_candidate_id, trade_id, session_id, decision, emotion_after,
          rule_violations, lesson, process_grade, outcome
        ) VALUES ($6,$1,$2,$3,'PAPER_RECOVERY_CLOSE','AUTO','NONE',$4,'B',$5)`,
        [
          trade.setup_candidate_id,
          trade.id,
          trade.session_id,
          `Recovered stale paper trade by ${exit.reason}. Result ${resultR.toFixed(2)}R.`,
          outcome,
          trade.tenant_id
        ]
      );
      recovered.push({ ...updated.rows[0], direction: trade.direction, module_code: moduleCode, recoveryReason: exit.reason });
    }
    return { checked: active.rows.length, recovered };
  });

  app.get("/api/trade-plans/current", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const currentSessionDate = newYorkDate();
    const { rows } = await query(`
      SELECT tp.*, sc.symbol, sc.direction, sc.scenario, sc.module_code, sc.status AS setup_status,
        sc.detected_at AS setup_detected_at, sc.expires_at AS setup_expires_at,
        sc.favorability_score, sc.favorability_grade, sc.final_reason, sc.scenario_flags,
        t.id AS active_trade_id, t.actual_entry, t.actual_stop, t.actual_target, t.opened_at AS trade_opened_at
      FROM trade_plans tp
      JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
      JOIN trading_sessions current_session
        ON current_session.id = sc.session_id
       AND current_session.session_date = $3::date
      LEFT JOIN trades t ON t.trade_plan_id = tp.id AND t.outcome = 'ACTIVE'
      WHERE sc.tenant_id = $1
        AND sc.module_code = $2
        AND sc.scenario <> 'QA_TEST_SIGNAL'
        AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
        AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
        AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'
        AND tp.status IN ('DRAFT', 'READY', 'EXECUTED')
        AND (
          t.id IS NOT NULL
          OR (
            sc.status IN ('LONG SETUP READY', 'SHORT SETUP READY', 'TRADE_PLANNED', 'PAPER_TRADE_OPENED')
            AND (sc.expires_at IS NULL OR sc.expires_at > now())
          )
        )
        AND (
          (sc.direction = 'LONG' AND tp.planned_stop < tp.planned_entry AND tp.planned_entry < tp.planned_target)
          OR
          (sc.direction = 'SHORT' AND tp.planned_target < tp.planned_entry AND tp.planned_entry < tp.planned_stop)
        )
      ORDER BY CASE WHEN t.id IS NOT NULL THEN 0 ELSE 1 END,
               COALESCE(tp.promoted_at, tp.created_at) DESC
      LIMIT 1
    `, [auth.tenantId, moduleCode, currentSessionDate]);
    return rows[0] ?? null;
  });

  app.get("/api/trade-plans/history", async (request) => {
    const search = request.query as { moduleCode?: string; limit?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const limit = Math.min(Math.max(Number(search.limit ?? 50), 1), 200);
    const auth = await requireTenantModule(request, moduleCode);
    const { rows } = await query(
      `SELECT tp.*, sc.symbol, sc.direction, sc.scenario, sc.module_code,
              sc.detected_at AS setup_detected_at, sc.final_reason,
              t.id AS trade_id, t.outcome, t.actual_exit, t.result_r, t.closed_at
       FROM trade_plans tp
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       LEFT JOIN trades t ON t.trade_plan_id = tp.id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'
       ORDER BY COALESCE(tp.promoted_at, tp.created_at) DESC
       LIMIT $3`,
      [auth.tenantId, moduleCode, limit]
    );
    return rows;
  });

  app.post("/api/setups/:id/trade-plan", async (request) => {
    const { id } = request.params as { id: string };
    const setupResult = await query("SELECT * FROM setup_candidates WHERE id = $1", [id]);
    const setup = setupResult.rows[0] as any;
    if (!setup) return { error: "Setup not found" };
    const auth = await requireTenantModule(request, setup.module_code ?? "orb_max_options");
    if (setup.tenant_id !== auth.tenantId) return { error: "Setup not found" };
    if (setup.entry_price == null || setup.stop_price == null || setup.target_price == null) {
      return { error: "Setup does not have entry, stop, and target prices." };
    }
    const latestRisk = await query(
      `SELECT calculation
       FROM risk_events
       WHERE setup_candidate_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [id]
    );
    const risk = latestRisk.rows[0]?.calculation as any | undefined;
    const { rows } = await query(
      `INSERT INTO trade_plans (
        setup_candidate_id, planned_entry, planned_stop, planned_target,
        planned_lot, planned_risk_amount, reward_to_risk, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT')
      ON CONFLICT (setup_candidate_id) DO UPDATE SET
        planned_entry = EXCLUDED.planned_entry,
        planned_stop = EXCLUDED.planned_stop,
        planned_target = EXCLUDED.planned_target,
        planned_lot = EXCLUDED.planned_lot,
        planned_risk_amount = EXCLUDED.planned_risk_amount,
        reward_to_risk = EXCLUDED.reward_to_risk
      RETURNING *`,
      [
        id,
        setup.entry_price,
        setup.stop_price,
        setup.target_price,
        risk?.suggestedLotSize ?? null,
        risk?.plannedRiskAmount ?? null,
        risk?.rewardToRisk ?? null
      ]
    );
    await query("UPDATE setup_candidates SET status = 'TRADE_PLANNED' WHERE id = $1 AND tenant_id = $2", [id, auth.tenantId]);
    return rows[0];
  });

  app.post("/api/trade-plans/:id/execute", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const planScope = await query(
      `SELECT sc.tenant_id, sc.module_code
       FROM trade_plans tp
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE tp.id = $1`,
      [id]
    );
    const scope = planScope.rows[0] as any;
    if (!scope) return { error: "Trade plan not found" };
    const auth = await requireTenantModule(request, scope.module_code ?? "orb_max_options");
    if (scope.tenant_id !== auth.tenantId) return { error: "Trade plan not found" };
    const { rows } = await query(
      `INSERT INTO trades (
        trade_plan_id, actual_entry, actual_stop, actual_target, actual_lot,
        commission, spread, slippage, opened_at, outcome
      )
      SELECT tp.id, $2, $3, $4, $5, $6, $7, $8, now(), 'ACTIVE'
      FROM trade_plans tp
      JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
      WHERE tp.id = $1 AND sc.tenant_id = $9
      RETURNING *`,
      [
        id,
        body.actualEntry,
        body.actualStop,
        body.actualTarget,
        body.actualLot,
        body.commission ?? 0,
        body.spread ?? 0,
        body.slippage ?? 0,
        auth.tenantId
      ]
    );
    await query(
      `UPDATE trade_plans tp
       SET status = 'EXECUTED'
       FROM setup_candidates sc
       WHERE tp.id = $1 AND sc.id = tp.setup_candidate_id AND sc.tenant_id = $2`,
      [id, auth.tenantId]
    );
    await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,'MANUAL_EXECUTION',$2)", [rows[0].id, body]);
    await ensurePaperTradeTargets(rows[0].id);
    return rows[0];
  });

  app.post("/api/trades/:id/close", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const tradeScope = await query(
      `SELECT sc.tenant_id, sc.module_code
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE t.id = $1`,
      [id]
    );
    const scope = tradeScope.rows[0] as any;
    if (!scope) return { error: "Trade not found" };
    const auth = await requireTenantModule(request, scope.module_code ?? "orb_max_options");
    if (scope.tenant_id !== auth.tenantId) return { error: "Trade not found" };
    const tradeResult = await query(
      `SELECT t.*, tp.planned_entry, tp.planned_stop, sc.direction
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE t.id = $1 AND sc.tenant_id = $2`,
      [id, auth.tenantId]
    );
    const trade = tradeResult.rows[0] as any;
    const actualExit = Number(body.actualExit);
    const lot = Number(trade.actual_lot ?? 0);
    const settlement = await paperTradeSettlement(trade, actualExit);
    const resultR = settlement.resultR;
    const resultMoney = body.resultMoney ?? null;
    const outcome = settlement.outcome;
    const { rows } = await query(
      `UPDATE trades SET
        actual_exit = $2,
        result_money = $3,
        result_r = $4,
        outcome = $5,
        closed_at = now(),
        remaining_fraction = 0
       WHERE id = $1
       RETURNING *`,
      [id, actualExit, resultMoney, resultR, outcome]
    );
    await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,'MANUAL_CLOSE',$2)", [id, { ...body, resultR, lot }]);
    await cancelPendingPaperTargets(id, "MANUAL_CLOSE");
    await query("UPDATE trade_plans SET status = 'CLOSED' WHERE id = $1", [trade.trade_plan_id]);
    return rows[0];
  });

  app.get("/api/trades/current", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const currentSessionDate = newYorkDate();
    const { rows } = await query(`
      SELECT t.*, tp.setup_candidate_id, sc.symbol, sc.direction, sc.scenario, sc.module_code
      FROM trades t
      JOIN trade_plans tp ON tp.id = t.trade_plan_id
      JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
      JOIN trading_sessions current_session
        ON current_session.id = sc.session_id
       AND current_session.session_date = $3::date
      JOIN LATERAL (
        SELECT c.timestamp_utc
        FROM candles c
        WHERE c.symbol = sc.symbol
          AND c.timeframe_minutes = 5
          AND c.source LIKE 'TWELVE_DATA%'
        ORDER BY c.timestamp_utc DESC
        LIMIT 1
      ) latest ON true
      WHERE sc.tenant_id = $1
        AND sc.module_code = $2
        AND sc.scenario <> 'QA_TEST_SIGNAL'
        AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
        AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
        AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'
        AND (sc.expires_at IS NULL OR sc.expires_at >= now() OR t.outcome = 'ACTIVE')
        AND (t.outcome = 'ACTIVE' OR sc.detected_at >= latest.timestamp_utc)
      ORDER BY CASE WHEN t.outcome = 'ACTIVE' THEN 0 ELSE 1 END, COALESCE(t.opened_at, now()) DESC
      LIMIT 1
    `, [auth.tenantId, moduleCode, currentSessionDate]);
    return rows[0] ?? null;
  });

  app.get("/api/trades/chart-markers", async (request) => {
    const search = request.query as { symbol?: string; limit?: string; moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const symbol = search.symbol ?? "XAUUSD";
    const currentSessionDate = newYorkDate();
    const limit = Math.min(Number(search.limit ?? 100), 500);
    const { rows } = await query(
      `SELECT
        t.id,
        t.actual_entry,
        t.actual_exit,
        t.result_r,
        t.outcome,
        t.opened_at,
        t.closed_at,
        t.actual_stop,
        t.actual_target,
        tp.planned_entry,
        tp.planned_stop,
        tp.planned_target,
        tp.reward_to_risk,
        sc.symbol,
        sc.direction,
        sc.scenario,
        sc.favorability_score,
        sc.scenario_flags
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       JOIN trading_sessions current_session
         ON current_session.id = sc.session_id
        AND current_session.session_date = $5::date
       WHERE sc.symbol = $1
         AND sc.tenant_id = $3
         AND sc.module_code = $4
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'
       ORDER BY COALESCE(t.opened_at, t.closed_at) DESC
       LIMIT $2`,
      [symbol, limit, auth.tenantId, moduleCode, currentSessionDate]
    );
    return rows.flatMap((trade: any) => {
      const entryMarker = trade.opened_at
        ? [
            {
              id: `${trade.id}-entry`,
              tradeId: trade.id,
              type: "ENTRY",
              time: trade.opened_at,
              price: trade.actual_entry,
              direction: trade.direction,
              scenario: trade.scenario,
              entry: trade.actual_entry ?? trade.planned_entry,
              stop: trade.actual_stop ?? trade.planned_stop,
              target: trade.actual_target ?? trade.planned_target,
              rewardToRisk: trade.reward_to_risk,
              confidence: trade.favorability_score,
              setupTier: trade.scenario_flags?.setupTier ?? null,
              text: "Paper trade audit entry"
            }
          ]
        : [];
      const exitMarker = trade.closed_at
        ? [
            {
              id: `${trade.id}-exit`,
              tradeId: trade.id,
              type: "EXIT",
              time: trade.closed_at,
              price: trade.actual_exit,
              direction: trade.direction,
              scenario: trade.scenario,
              outcome: trade.outcome,
              resultR: trade.result_r,
              text: `Exit ${trade.outcome ?? ""} ${Number(trade.result_r ?? 0).toFixed(2)}R`
            }
          ]
        : [];
      return [...entryMarker, ...exitMarker];
    });
  });

  app.post("/api/dev/module2-trade-lifecycle", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const body = request.body as {
      setupId?: string;
      tradeId?: string;
      event?: "ENTRY_HIT" | "TP_HIT" | "SL_HIT" | "EXPIRED_SETUP" | "MISSED_ENTRY" | "MANUAL_CLOSE";
      actualExit?: number;
    };
    const event = body.event ?? "ENTRY_HIT";
    const setup = await resolveModule2Setup(auth.tenantId, body.setupId, body.tradeId);
    if (!setup) return { error: "Module 2 setup not found" };
    if (["EXPIRED_SETUP", "MISSED_ENTRY"].includes(event)) {
      const nextStatus = event === "EXPIRED_SETUP" ? "EXPIRED" : "MISSED";
      const { rows } = await query("UPDATE setup_candidates SET status = $2 WHERE id = $1 AND tenant_id = $3 RETURNING *", [setup.id, nextStatus, auth.tenantId]);
      await query(
        `INSERT INTO journal_entries (
          tenant_id, setup_candidate_id, session_id, decision, lesson, process_grade, outcome
        ) VALUES ($1,$2,$3,$4,$5,'QA',$6)`,
        [auth.tenantId, setup.id, setup.session_id, `MODULE2_QA_${event}`, module2LifecycleLesson(event), nextStatus]
      );
      return { setup: rows[0], event, trade: null };
    }

    const trade = event === "ENTRY_HIT"
      ? await openPaperTrade(setup, auth.tenantId)
      : await closePaperTrade(setup, auth.tenantId, event, body.actualExit);
    return { setup, trade, event };
  });

  app.post("/api/dev/modules/:moduleCode/trade-lifecycle", async (request) => {
    const { moduleCode } = request.params as { moduleCode: string };
    const auth = await requireTenantModule(request, moduleCode);
    const body = request.body as {
      setupId?: string;
      tradeId?: string;
      event?: "ENTRY_HIT" | "TP_HIT" | "SL_HIT" | "EXPIRED_SETUP" | "MISSED_ENTRY" | "MANUAL_CLOSE";
      actualExit?: number;
    };
    const event = body.event ?? "ENTRY_HIT";
    const setup = await resolveModuleSetup(auth.tenantId, moduleCode, body.setupId, body.tradeId);
    if (!setup) return { error: "Module setup not found" };
    if (["EXPIRED_SETUP", "MISSED_ENTRY"].includes(event)) {
      const nextStatus = event === "EXPIRED_SETUP" ? "EXPIRED" : "MISSED";
      const { rows } = await query("UPDATE setup_candidates SET status = $2 WHERE id = $1 AND tenant_id = $3 AND module_code = $4 RETURNING *", [setup.id, nextStatus, auth.tenantId, moduleCode]);
      await query(
        `INSERT INTO journal_entries (
          tenant_id, setup_candidate_id, session_id, decision, lesson, process_grade, outcome
        ) VALUES ($1,$2,$3,$4,$5,'QA',$6)`,
        [auth.tenantId, setup.id, setup.session_id, `${moduleCode.toUpperCase()}_QA_${event}`, moduleLifecycleLesson(moduleCode, event), nextStatus]
      );
      return { setup: rows[0], event, trade: null };
    }

    const trade = event === "ENTRY_HIT"
      ? await openPaperTrade(setup, auth.tenantId, moduleCode)
      : await closePaperTrade(setup, auth.tenantId, event, body.actualExit, moduleCode);
    return { setup, trade, event };
  });

  app.get("/api/module2/journal/trades", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const search = request.query as { limit?: string };
    const limit = Math.min(Number(search.limit ?? 25), 100);
    const { rows } = await query(
      `SELECT
        t.*, tp.setup_candidate_id, tp.reward_to_risk, sc.session_id, sc.symbol, sc.direction, sc.scenario,
        sc.status AS setup_status, sc.detected_at, sc.favorability_score, sc.favorability_grade,
        sc.final_reason, sc.scenario_flags,
        (SELECT jsonb_agg(jsonb_build_object('targetNumber', ptt.target_number, 'price', ptt.price, 'riskMultiple', ptt.risk_multiple, 'positionFraction', ptt.position_fraction, 'realizedR', ptt.realized_r, 'status', ptt.status, 'hitAt', ptt.hit_at) ORDER BY ptt.target_number)
         FROM paper_trade_targets ptt WHERE ptt.trade_id = t.id) AS targets
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1 AND sc.module_code = 'high_probability_strategy_2'
       ORDER BY COALESCE(t.opened_at, sc.detected_at) DESC
       LIMIT $2`,
      [auth.tenantId, limit]
    );
    return rows;
  });

  app.get("/api/module2/journal/trades/:id", async (request, reply) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const { id } = request.params as { id: string };
    const trade = await query(
      `SELECT
        t.*, tp.setup_candidate_id, tp.planned_entry, tp.planned_stop, tp.planned_target, tp.reward_to_risk,
        sc.session_id, sc.symbol, sc.direction, sc.scenario, sc.status AS setup_status, sc.detected_at,
        sc.entry_price, sc.stop_price, sc.target_price, sc.favorability_score, sc.favorability_grade,
        sc.final_reason, sc.favorability_reasons, sc.scenario_flags
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE t.id = $1 AND sc.tenant_id = $2 AND sc.module_code = 'high_probability_strategy_2'
       LIMIT 1`,
      [id, auth.tenantId]
    );
    if (!trade.rows[0]) return reply.code(404).send({ message: "Module 2 trade not found" });
    const [evaluations, events, journal] = await Promise.all([
      query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [trade.rows[0].setup_candidate_id]),
      query("SELECT * FROM trade_events WHERE trade_id = $1 ORDER BY created_at", [id]),
      query("SELECT * FROM journal_entries WHERE trade_id = $1 AND tenant_id = $2 ORDER BY created_at DESC", [id, auth.tenantId])
    ]);
    return {
      trade: trade.rows[0],
      evaluations: evaluations.rows,
      events: events.rows,
      journal: journal.rows,
      chartSnapshotCandles: trade.rows[0].scenario_flags?.chartSnapshotCandles ?? []
    };
  });

  app.get("/api/modules/:moduleCode/journal/trades", async (request) => {
    const { moduleCode } = request.params as { moduleCode: string };
    const auth = await requireTenantModule(request, moduleCode);
    const search = request.query as { limit?: string };
    const limit = Math.min(Number(search.limit ?? 25), 100);
    const { rows } = await query(
      `SELECT
        t.*, tp.setup_candidate_id, tp.reward_to_risk, sc.session_id, sc.symbol, sc.direction, sc.scenario,
        sc.status AS setup_status, sc.detected_at, sc.favorability_score, sc.favorability_grade,
        sc.final_reason, sc.scenario_flags, sc.module_code,
        (SELECT jsonb_agg(jsonb_build_object('targetNumber', ptt.target_number, 'price', ptt.price, 'riskMultiple', ptt.risk_multiple, 'positionFraction', ptt.position_fraction, 'realizedR', ptt.realized_r, 'status', ptt.status, 'hitAt', ptt.hit_at) ORDER BY ptt.target_number)
         FROM paper_trade_targets ptt WHERE ptt.trade_id = t.id) AS targets
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1 AND sc.module_code = $2
       ORDER BY COALESCE(t.opened_at, sc.detected_at) DESC
       LIMIT $3`,
      [auth.tenantId, moduleCode, limit]
    );
    return rows;
  });

  app.get("/api/modules/:moduleCode/journal/trades/:id", async (request, reply) => {
    const { moduleCode, id } = request.params as { moduleCode: string; id: string };
    const auth = await requireTenantModule(request, moduleCode);
    const trade = await query(
      `SELECT
        t.*, tp.setup_candidate_id, tp.planned_entry, tp.planned_stop, tp.planned_target, tp.reward_to_risk,
        sc.session_id, sc.symbol, sc.direction, sc.scenario, sc.status AS setup_status, sc.detected_at,
        sc.entry_price, sc.stop_price, sc.target_price, sc.favorability_score, sc.favorability_grade,
        sc.final_reason, sc.favorability_reasons, sc.scenario_flags, sc.module_code
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE t.id = $1 AND sc.tenant_id = $2 AND sc.module_code = $3
       LIMIT 1`,
      [id, auth.tenantId, moduleCode]
    );
    if (!trade.rows[0]) return reply.code(404).send({ message: "Module trade not found" });
    const [evaluations, events, journal, snapshots] = await Promise.all([
      query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [trade.rows[0].setup_candidate_id]),
      query("SELECT * FROM trade_events WHERE trade_id = $1 ORDER BY created_at", [id]),
      query("SELECT * FROM journal_entries WHERE trade_id = $1 AND tenant_id = $2 ORDER BY created_at DESC", [id, auth.tenantId]),
      query("SELECT * FROM setup_candle_snapshots WHERE setup_candidate_id = $1 ORDER BY timestamp_utc", [trade.rows[0].setup_candidate_id])
    ]);
    return {
      trade: trade.rows[0],
      evaluations: evaluations.rows,
      events: events.rows,
      journal: journal.rows,
      chartSnapshotCandles: snapshots.rows.length > 0 ? snapshots.rows : trade.rows[0].scenario_flags?.chartSnapshotCandles ?? []
    };
  });

  app.get("/api/sessions/:id/review", async (request) => {
    const { id } = request.params as { id: string };
    const scopeResult = await query("SELECT tenant_id, module_code FROM trading_sessions WHERE id = $1", [id]);
    const scope = scopeResult.rows[0] as any;
    if (!scope) return { session: null, setups: [], trades: [], journal: [], summary: { setupCount: 0, tradeCount: 0, totalR: 0 } };
    const auth = await requireTenantModule(request, scope.module_code ?? "orb_max_options");
    if (scope.tenant_id !== auth.tenantId) return { session: null, setups: [], trades: [], journal: [], summary: { setupCount: 0, tradeCount: 0, totalR: 0 } };
    const session = await query(
      `SELECT ts.*, row_to_json(orr.*) AS opening_range
       FROM trading_sessions ts
       LEFT JOIN opening_ranges orr ON orr.session_id = ts.id
       WHERE ts.id = $1 AND ts.tenant_id = $2`,
      [id, auth.tenantId]
    );
    const setups = await query("SELECT * FROM setup_candidates WHERE session_id = $1 AND tenant_id = $2 ORDER BY detected_at", [id, auth.tenantId]);
    const trades = await query(
      `SELECT t.*, tp.setup_candidate_id, sc.direction, sc.scenario
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.session_id = $1 AND sc.tenant_id = $2
       ORDER BY t.opened_at`,
      [id, auth.tenantId]
    );
    const journal = await query("SELECT * FROM journal_entries WHERE session_id = $1 AND tenant_id = $2 ORDER BY created_at DESC", [id, auth.tenantId]);
    const totalR = trades.rows.reduce((sum: number, trade: any) => sum + Number(trade.result_r ?? 0), 0);
    return {
      session: session.rows[0] ?? null,
      setups: setups.rows,
      trades: trades.rows,
      journal: journal.rows,
      summary: {
        setupCount: setups.rows.length,
        tradeCount: trades.rows.length,
        totalR,
        latestProcessGrade: journal.rows[0]?.process_grade ?? null,
        latestLesson: journal.rows[0]?.lesson ?? null
      }
    };
  });
}

function emptyPaperTradeSummary() {
  return { total: 0, active: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, totalR: 0, averageR: 0 };
}

function summarizePaperTrades(trades: any[]) {
  const closed = trades.filter((trade) => trade.status !== "ACTIVE");
  const wins = closed.filter((trade) => trade.status === "WIN").length;
  const losses = closed.filter((trade) => trade.status === "LOSS").length;
  const totalR = closed.reduce((sum, trade) => sum + Number(trade.resultR ?? 0), 0);
  return {
    total: trades.length,
    active: trades.filter((trade) => trade.status === "ACTIVE").length,
    wins,
    losses,
    breakeven: closed.filter((trade) => trade.status === "BREAKEVEN").length,
    winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
    totalR,
    averageR: closed.length > 0 ? totalR / closed.length : 0
  };
}

async function settleOpenPaperTrades(tenantId: string, moduleCode: string, includeProof = false) {
  const params: unknown[] = [tenantId];
  const moduleFilter = moduleCode !== "ALL" ? `AND sc.module_code = $${params.push(moduleCode)}` : "";
  const productionFilter = includeProof
    ? ""
    : `AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
       AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
       AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'`;
  const active = await query(
    `SELECT
       t.*,
       tp.id AS trade_plan_id,
       tp.setup_candidate_id,
       sc.tenant_id,
       sc.session_id,
       sc.symbol,
       sc.direction,
       sc.scenario,
       sc.module_code
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.tenant_id = $1
       AND t.outcome = 'ACTIVE'
       AND t.opened_at IS NOT NULL
       ${moduleFilter}
       ${productionFilter}
     ORDER BY t.opened_at ASC`,
    params
  );

  for (const trade of active.rows as any[]) {
    const candles = await query(
      `SELECT timestamp_utc, open, high, low, close
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND source LIKE 'TWELVE_DATA%'
         AND timestamp_utc >= $3
       ORDER BY timestamp_utc ASC`,
      [trade.symbol, moduleExecutionTimeframeMinutes(trade.module_code), trade.opened_at]
    );
    let exit = null as any;
    for (const candle of candles.rows as any[]) {
      const progress = await evaluatePaperTargetMilestones(trade, candle);
      if (progress.stopHit) {
        exit = { reason: progress.stopReason ?? "STOP", price: progress.stopPrice, timestampUtc: candle.timestamp_utc, candle, ambiguous: progress.ambiguous };
        break;
      }
      if (progress.finalTargetHit) {
        exit = { reason: "TARGET", price: Number(trade.actual_target), timestampUtc: candle.timestamp_utc, candle, ambiguous: false };
        break;
      }
    }
    if (!exit) continue;
    const settlement = await paperTradeSettlement(trade, exit.price);
    const { resultR, outcome } = settlement;
    await query(
      `UPDATE trades SET
         actual_exit = $2,
         result_r = $3,
         outcome = $4,
         closed_at = $5,
         remaining_fraction = 0
       WHERE id = $1
         AND outcome = 'ACTIVE'`,
      [trade.id, exit.price, resultR, outcome, exit.timestampUtc]
    );
    await cancelPendingPaperTargets(trade.id, exit.reason);
    await query("UPDATE trade_plans SET status = 'CLOSED' WHERE id = $1", [trade.trade_plan_id]);
    await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,'PAPER_AUTO_CLOSE',$2)", [
      trade.id,
      { mode: "PAPER", moduleCode: trade.module_code, exitReason: exit.reason, candle: exit.candle, settledFrom: "paper-ledger" }
    ]);
    await query(
      `INSERT INTO journal_entries (
        tenant_id, setup_candidate_id, trade_id, session_id, decision, emotion_after,
        rule_violations, lesson, process_grade, outcome
      ) VALUES ($6,$1,$2,$3,'PAPER_AUTO_CLOSE','AUTO','NONE',$4,'A',$5)`,
      [
        trade.setup_candidate_id,
        trade.id,
        trade.session_id,
        `Paper trade auto-closed by ${exit.reason}. Result ${resultR.toFixed(2)}R.`,
        outcome,
        trade.tenant_id
      ]
    );
  }
}

function paperTradeView(row: any) {
  const direction = row.direction === "SHORT" ? "SHORT" : "LONG";
  const entry = Number(row.actual_entry);
  const stop = Number(row.actual_stop);
  const structuralStop = Number(row.structural_stop ?? row.actual_stop);
  const target = Number(row.actual_target);
  const currentPrice = row.current_price == null ? null : Number(row.current_price);
  const stopDistance = Math.abs(entry - structuralStop);
  const entryDistanceFromCurrent = currentPrice == null ? null : Math.abs(currentPrice - entry);
  const staleMarketDistance = currentPrice != null && stopDistance > 0 && entryDistanceFromCurrent != null
    ? entryDistanceFromCurrent > Math.max(stopDistance * 3, 10)
    : false;
  const multiplier = direction === "SHORT" ? -1 : 1;
  const lockedR = Number(row.realized_r ?? 0);
  const remainingFraction = Number(row.remaining_fraction ?? 1);
  const unrealizedR = row.outcome === "ACTIVE" && currentPrice != null && stopDistance > 0
    ? lockedR + remainingFraction * (((currentPrice - entry) * multiplier) / stopDistance)
    : null;
  return {
    id: row.id,
    setupCandidateId: row.setup_candidate_id,
    moduleCode: row.module_code,
    symbol: row.symbol,
    scenario: row.scenario,
    direction,
    action: direction === "SHORT" ? "SELL" : "BUY",
    entry,
    stopLoss: stop,
    structuralStop,
    takeProfit: target,
    currentPrice,
    currentPriceAt: row.current_price_at,
    entryDistanceFromCurrent,
    staleMarketDistance,
    marketContext: staleMarketDistance
      ? "HISTORICAL_PRICE_CONTEXT"
      : row.outcome === "ACTIVE"
        ? "LIVE_PRICE_CONTEXT"
        : "NORMAL_HISTORY",
    lot: row.actual_lot == null ? null : Number(row.actual_lot),
    rewardToRisk: row.reward_to_risk == null ? null : Number(row.reward_to_risk),
    plannedRiskAmount: row.planned_risk_amount == null ? null : Number(row.planned_risk_amount),
    status: row.outcome,
    condition: paperTradeCondition(row.outcome, unrealizedR, row.reward_to_risk == null ? null : Number(row.reward_to_risk), row.targets, row.breakeven_activated_at),
    unrealizedR,
    lockedR,
    remainingFraction,
    breakevenProtected: row.breakeven_activated_at != null,
    breakevenActivatedAt: row.breakeven_activated_at,
    maxFavorableExcursionR: Number(row.max_favorable_excursion_r ?? 0),
    maxAdverseExcursionR: Number(row.max_adverse_excursion_r ?? 0),
    exit: row.actual_exit == null ? null : Number(row.actual_exit),
    resultR: row.result_r == null ? null : Number(row.result_r),
    resultMoney: row.result_money == null ? null : Number(row.result_money),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    grade: row.favorability_grade,
    confidence: row.favorability_score == null ? null : Number(row.favorability_score),
    reason: row.final_reason,
    targets: normalizePaperTargets(row.targets),
    targetProgress: paperTargetProgress(row.targets)
  };
}

function normalizePaperTargets(targets: any) {
  if (!Array.isArray(targets)) return [];
  return targets.map((target: any) => ({
    ...target,
    targetNumber: Number(target.targetNumber),
    price: Number(target.price),
    riskMultiple: Number(target.riskMultiple),
    positionFraction: Number(target.positionFraction ?? 0),
    realizedR: target.realizedR == null ? null : Number(target.realizedR),
    hitPrice: target.hitPrice == null ? null : Number(target.hitPrice)
  }));
}

function paperTargetProgress(targets: any) {
  const rows = normalizePaperTargets(targets);
  const hit = rows.filter((target: any) => target.status === "HIT");
  return {
    hitCount: hit.length,
    total: rows.length,
    latestHit: hit.length > 0 ? `TP${Math.max(...hit.map((target: any) => target.targetNumber))}` : null,
    lockedR: hit.reduce((total: number, target: any) => total + Number(target.realizedR ?? 0), 0),
    realizedFraction: hit.reduce((total: number, target: any) => total + Number(target.positionFraction ?? 0), 0),
    finalTargetHit: rows.some((target: any) => target.targetNumber === 3 && target.status === "HIT")
  };
}

function paperTradeCondition(status: string, unrealizedR: number | null, rewardToRisk: number | null, targets?: any, breakevenActivatedAt?: unknown) {
  const progress = paperTargetProgress(targets);
  if (status === "WIN") return progress.finalTargetHit ? "TARGET HIT" : "PARTIAL PROFIT";
  if (status === "LOSS") return "SL HIT";
  if (status === "BREAKEVEN") return "BREAKEVEN";
  if (status !== "ACTIVE") return status || "CLOSED";
  if (unrealizedR == null) return "AWAITING PRICE";
  if (unrealizedR <= -1) return "SL HIT";
  if (rewardToRisk != null && unrealizedR >= rewardToRisk) return "TARGET HIT";
  if (breakevenActivatedAt != null) return `${progress.latestHit ?? "TP1"} · BE PROTECTED`;
  if (progress.latestHit) return `${progress.latestHit} HIT`;
  if (unrealizedR >= 1.5) return "NEAR TARGET";
  if (unrealizedR > 0) return "IN PROFIT";
  if (unrealizedR <= -0.7) return "NEAR STOP";
  if (unrealizedR < 0) return "IN DRAWDOWN";
  return "AT ENTRY";
}

function moduleExecutionTimeframeMinutes(moduleCode: string) {
  return ["orb_max_options", "high_probability_strategy_2"].includes(moduleCode) ? 5 : 5;
}

async function resolveModule2Setup(tenantId: string | null, setupId?: string, tradeId?: string) {
  if (setupId) {
    const { rows } = await query("SELECT * FROM setup_candidates WHERE id = $1 AND tenant_id = $2 AND module_code = 'high_probability_strategy_2'", [setupId, tenantId]);
    return rows[0] as any;
  }
  if (tradeId) {
    const { rows } = await query(
      `SELECT sc.*
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE t.id = $1 AND sc.tenant_id = $2 AND sc.module_code = 'high_probability_strategy_2'`,
      [tradeId, tenantId]
    );
    return rows[0] as any;
  }
  const { rows } = await query(
    "SELECT * FROM setup_candidates WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2' AND status <> 'TEST_CLEARED' ORDER BY detected_at DESC LIMIT 1",
    [tenantId]
  );
  return rows[0] as any;
}

async function resolveModuleSetup(tenantId: string | null, moduleCode: string, setupId?: string, tradeId?: string) {
  if (setupId) {
    const { rows } = await query("SELECT * FROM setup_candidates WHERE id = $1 AND tenant_id = $2 AND module_code = $3", [setupId, tenantId, moduleCode]);
    return rows[0] as any;
  }
  if (tradeId) {
    const { rows } = await query(
      `SELECT sc.*
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE t.id = $1 AND sc.tenant_id = $2 AND sc.module_code = $3`,
      [tradeId, tenantId, moduleCode]
    );
    return rows[0] as any;
  }
  const { rows } = await query(
    "SELECT * FROM setup_candidates WHERE tenant_id = $1 AND module_code = $2 AND status <> 'TEST_CLEARED' ORDER BY detected_at DESC LIMIT 1",
    [tenantId, moduleCode]
  );
  return rows[0] as any;
}

async function openPaperTrade(setup: any, tenantId: string | null, moduleCode = "high_probability_strategy_2") {
  if (setup.entry_price == null || setup.stop_price == null || setup.target_price == null) return { error: "Setup has no executable paper prices." };
  const rr = Math.abs(Number(setup.target_price) - Number(setup.entry_price)) / Math.max(0.00001, Math.abs(Number(setup.entry_price) - Number(setup.stop_price)));
  const plan = await query(
    `INSERT INTO trade_plans (
      setup_candidate_id, planned_entry, planned_stop, planned_target, planned_lot, planned_risk_amount, reward_to_risk, status
    ) VALUES ($1,$2,$3,$4,0.01,10,$5,'EXECUTED')
    ON CONFLICT (setup_candidate_id) DO UPDATE SET status = 'EXECUTED' RETURNING *`,
    [setup.id, setup.entry_price, setup.stop_price, setup.target_price, rr]
  );
  const existing = await query("SELECT * FROM trades WHERE trade_plan_id = $1 AND outcome = 'ACTIVE' ORDER BY opened_at DESC LIMIT 1", [plan.rows[0].id]);
  if (existing.rows[0]) {
    await ensurePaperTradeTargets(existing.rows[0].id);
    return existing.rows[0];
  }
  const { rows } = await query(
    `INSERT INTO trades (
      trade_plan_id, actual_entry, actual_stop, actual_target, actual_lot, commission, spread, slippage, opened_at, outcome
    ) VALUES ($1,$2,$3,$4,0.01,0,0.2,0,now(),'ACTIVE') RETURNING *`,
    [plan.rows[0].id, setup.entry_price, setup.stop_price, setup.target_price]
  );
  await query("UPDATE setup_candidates SET status = 'PAPER_TRADE_OPENED' WHERE id = $1 AND tenant_id = $2", [setup.id, tenantId]);
  await ensurePaperTradeTargets(rows[0].id);
  await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,$2,$3)", [rows[0].id, `${moduleCode.toUpperCase()}_QA_ENTRY_HIT`, { setupId: setup.id, moduleCode }]);
  return rows[0];
}

async function closePaperTrade(setup: any, tenantId: string | null, event: string, actualExit?: number, moduleCode = "high_probability_strategy_2") {
  const active = await query(
    `SELECT t.*, tp.id AS plan_id, sc.direction
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.id = $1 AND sc.tenant_id = $2 AND t.outcome = 'ACTIVE'
     ORDER BY t.opened_at DESC
     LIMIT 1`,
    [setup.id, tenantId]
  );
  const trade = active.rows[0] as any;
  if (!trade) return { error: "No active module paper trade to close." };
  const exit = event === "TP_HIT" ? Number(trade.actual_target) : event === "SL_HIT" ? Number(trade.actual_stop) : Number(actualExit ?? trade.actual_entry);
  const settlement = await paperTradeSettlement(trade, exit);
  const { resultR, outcome } = settlement;
  const { rows } = await query(
    "UPDATE trades SET actual_exit = $2, result_r = $3, outcome = $4, closed_at = now(), remaining_fraction = 0 WHERE id = $1 RETURNING *",
    [trade.id, exit, resultR, outcome]
  );
  await cancelPendingPaperTargets(trade.id, event);
  await query("UPDATE trade_plans SET status = 'CLOSED' WHERE id = $1", [trade.plan_id]);
  await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,$2,$3)", [trade.id, `${moduleCode.toUpperCase()}_QA_${event}`, { exit, resultR, outcome, moduleCode }]);
  await query(
    `INSERT INTO journal_entries (
      tenant_id, setup_candidate_id, trade_id, session_id, decision, lesson, process_grade, outcome
    ) VALUES ($1,$2,$3,$4,$5,$6,'QA',$7)`,
    [tenantId, setup.id, trade.id, setup.session_id, `${moduleCode.toUpperCase()}_QA_${event}`, moduleLifecycleLesson(moduleCode, event), outcome]
  );
  return rows[0];
}

function moduleLifecycleLesson(moduleCode: string, event: string) {
  const moduleName = moduleCode === "high_probability_strategy_2" ? "Module 2" : "Module";
  const lessons: Record<string, string> = {
    ENTRY_HIT: `Entry was hit after ${moduleName} checklist validation.`,
    TP_HIT: "Target was reached; paper trade closed as a win.",
    SL_HIT: "Stop was reached; paper trade closed as a loss.",
    EXPIRED_SETUP: "Setup expired before entry and should not become a trade.",
    MISSED_ENTRY: "Entry zone was missed; no paper trade should open.",
    MANUAL_CLOSE: "QA manual close was used for lifecycle validation."
  };
  return lessons[event] ?? `${moduleName} QA lifecycle event recorded.`;
}

function module2LifecycleLesson(event: string) {
  const lessons: Record<string, string> = {
    ENTRY_HIT: "Entry was hit after Module 2 checklist validation.",
    TP_HIT: "Target was reached; paper trade closed as a win.",
    SL_HIT: "Stop was reached; paper trade closed as a loss.",
    EXPIRED_SETUP: "Setup expired before entry and should not become a trade.",
    MISSED_ENTRY: "Entry zone was missed; no paper trade should open.",
    MANUAL_CLOSE: "QA manual close was used for lifecycle validation."
  };
  return lessons[event] ?? "Module 2 QA lifecycle event recorded.";
}
