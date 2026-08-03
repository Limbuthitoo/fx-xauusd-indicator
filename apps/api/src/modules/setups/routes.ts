import { calculateRisk } from "@orb-guide/risk-engine";
import { buildOpeningRange, evaluateSetup } from "@orb-guide/strategy-engine";
import type { Candle } from "@orb-guide/shared-types";
import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { newYorkDate, sessionTimesForDate } from "../../infrastructure/time.js";
import { getTenantOrbStrategyConfiguration } from "../admin/settings.js";
import { requireTenantModule } from "../auth/routes.js";
import { canCreateTenantNotification } from "../billing/limits.js";

type ReplayCase = "BUY" | "SELL" | "RETEST" | "FAKEOUT" | "SWEEP_REVERSAL" | "OVEREXTENDED" | "NO_TRADE";
type Module2ReplayCase =
  | "BUY"
  | "SELL"
  | "SWEEP_NO_DISPLACEMENT"
  | "DISPLACEMENT_NO_BOS"
  | "BOS_NO_RETRACE"
  | "INVALIDATED_SETUP"
  | "LOW_SCORE_NO_TRADE";
type Module3ReplayCase =
  | "BUY"
  | "SELL"
  | "WEAK_OPENING_DRIVE"
  | "NO_VWAP_ALIGNMENT"
  | "NO_PULLBACK"
  | "NO_CONFIRMATION"
  | "INVALID_RR"
  | "NO_TRADE";

const XAUUSD_PAPER_SPEC = {
  contractSize: 100,
  tickSize: 0.01,
  tickValue: 1,
  minimumLot: 0.01,
  lotStep: 0.01,
  maximumLot: 50,
  commissionPerLot: 0
};

const MODULE2_QA_CASES: Array<{
  code: Module2ReplayCase;
  label: string;
  expected: string;
  expectedStatus: string;
  opensPaperTrade: boolean;
  failureRule?: string;
}> = [
  { code: "BUY", label: "Valid BUY", expected: "NY_LIQUIDITY_SWEEP_BOS_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "SELL", label: "Valid SELL", expected: "NY_LIQUIDITY_SWEEP_BOS_SELL", expectedStatus: "SHORT SETUP READY", opensPaperTrade: true },
  { code: "SWEEP_NO_DISPLACEMENT", label: "Sweep but no displacement", expected: "WAITING_FOR_DISPLACEMENT", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "DISPLACEMENT_CONFIRMED" },
  { code: "DISPLACEMENT_NO_BOS", label: "Displacement but no BOS", expected: "WAITING_FOR_BOS", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "BOS_CHOCH_CONFIRMED" },
  { code: "BOS_NO_RETRACE", label: "BOS but no retrace", expected: "WAITING_FOR_RETRACE", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "CONFIRM_ENTRY_CANDLE" },
  { code: "INVALIDATED_SETUP", label: "Invalidated setup", expected: "SETUP_INVALIDATED", expectedStatus: "NO TRADE", opensPaperTrade: false, failureRule: "CONFIRMATION_COUNT" },
  { code: "LOW_SCORE_NO_TRADE", label: "Low-score no trade", expected: "LOW_SCORE_NO_TRADE", expectedStatus: "NO TRADE", opensPaperTrade: false, failureRule: "CONFIRMATION_COUNT" }
];

const MODULE3_QA_CASES: Array<{
  code: Module3ReplayCase;
  label: string;
  expected: string;
  expectedStatus: string;
  opensPaperTrade: boolean;
  failureRule?: string;
}> = [
  { code: "BUY", label: "Valid BUY", expected: "NY_VWAP_OPENING_DRIVE_PULLBACK_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "SELL", label: "Valid SELL", expected: "NY_VWAP_OPENING_DRIVE_PULLBACK_SELL", expectedStatus: "SHORT SETUP READY", opensPaperTrade: true },
  { code: "WEAK_OPENING_DRIVE", label: "Weak opening drive", expected: "NO_STRONG_OPENING_DRIVE", expectedStatus: "NO TRADE", opensPaperTrade: false, failureRule: "OPENING_DRIVE_STRONG" },
  { code: "NO_VWAP_ALIGNMENT", label: "No VWAP alignment", expected: "VWAP_PULLBACK_NOT_READY", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "VWAP_ALIGNMENT" },
  { code: "NO_PULLBACK", label: "No pullback", expected: "VWAP_PULLBACK_NOT_READY", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "PULLBACK_ZONE_TOUCHED" },
  { code: "NO_CONFIRMATION", label: "No confirmation candle", expected: "VWAP_PULLBACK_NOT_READY", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "CONFIRMATION_CANDLE" },
  { code: "INVALID_RR", label: "Invalid RR", expected: "VWAP_PULLBACK_NOT_READY", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "QUALITY_RR" },
  { code: "NO_TRADE", label: "No trade", expected: "HARD_RULE_BLOCK", expectedStatus: "BLOCKED", opensPaperTrade: false, failureRule: "NY_SESSION_ACTIVE" }
];

const ORB_QA_CASES: Array<{ code: ReplayCase; label: string; expected: string; tradable: boolean }> = [
  { code: "BUY", label: "Valid BUY breakout", expected: "OPENING_DRIVE_CLEAN_BREAKOUT", tradable: true },
  { code: "SELL", label: "Valid SELL reversal", expected: "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED", tradable: true },
  { code: "RETEST", label: "Breakout retest", expected: "BREAKOUT_RETEST_CONFIRMED", tradable: true },
  { code: "FAKEOUT", label: "Fakeout candidate", expected: "FAKEOUT_REVERSAL_CANDIDATE", tradable: false },
  { code: "SWEEP_REVERSAL", label: "Sweep reversal", expected: "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED", tradable: true },
  { code: "OVEREXTENDED", label: "Overextended no-trade", expected: "OVEREXTENDED_BREAKOUT_NO_TRADE", tradable: false },
  { code: "NO_TRADE", label: "Double-sided sweep no-trade", expected: "DOUBLE_SIDED_SWEEP", tradable: false }
];

export async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setups/current", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const setup = await query(
      "SELECT * FROM setup_candidates WHERE tenant_id = $1 AND module_code = $2 AND status <> 'TEST_CLEARED' ORDER BY detected_at DESC LIMIT 1",
      [auth.tenantId, moduleCode]
    );
    if (!setup.rows[0]) return null;
    const evaluations = await query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [setup.rows[0].id]);
    return { ...setup.rows[0], evaluations: evaluations.rows };
  });

  app.get("/api/setups/history", async (request) => {
    const search = request.query as { moduleCode?: string; limit?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const limit = Math.min(100, Math.max(1, Number(search.limit ?? 30)));
    const auth = await requireTenantModule(request, moduleCode);
    const setups = await query(
      `SELECT
         sc.*,
         t.id AS trade_id,
         t.outcome,
         t.result_r,
         CASE WHEN t.id IS NULL THEN NULL WHEN t.outcome = 'ACTIVE' THEN 'ACTIVE' ELSE 'CLOSED' END AS trade_status,
         (
           SELECT sre.rule_code
           FROM setup_rule_evaluations sre
           WHERE sre.setup_candidate_id = sc.id AND sre.status <> 'PASS'
           ORDER BY sre.blocking DESC, sre.evaluated_at
           LIMIT 1
         ) AS blocking_rule,
         (
           SELECT count(*)::int
           FROM setup_rule_evaluations sre
           WHERE sre.setup_candidate_id = sc.id
         ) AS checklist_count,
         (
           SELECT count(*)::int
           FROM setup_rule_evaluations sre
           WHERE sre.setup_candidate_id = sc.id AND sre.status = 'PASS'
         ) AS checklist_passed
       FROM setup_candidates sc
       LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
       LEFT JOIN trades t ON t.trade_plan_id = tp.id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.status <> 'TEST_CLEARED'
       ORDER BY sc.detected_at DESC
       LIMIT $3`,
      [auth.tenantId, moduleCode, limit]
    );
    return setups.rows.map((row: any) => ({
      ...row,
      recommendation: setupRecommendation(row)
    }));
  });

  app.get("/api/dev/orb-replay/cases", async () => ({
    cases: ORB_QA_CASES
  }));

  app.post("/api/dev/orb-qa-suite", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const session = await ensureTodaySession(auth.tenantId);
    const version = await selectedStrategyVersion();
    const configuration = await getTenantOrbStrategyConfiguration(auth.tenantId, version.configuration_json);
    const cases = ORB_QA_CASES.map((testCase) => {
      const replay = buildReplay(testCase.code, session);
      const openingRange = buildOpeningRange(replay.openingRangeCandles, 0.01, 1);
      const decision = evaluateSetup({
        now: replay.currentCandle.timestampUtc,
        symbol: session.symbol,
        strategyVersionId: session.strategy_version_id,
        session: {
          id: session.id,
          symbol: session.symbol,
          strategyVersionId: session.strategy_version_id,
          sessionDate: session.session_date,
          sessionPreset: session.session_preset,
          state: "WAITING_FOR_SETUP",
          sessionStartAt: session.session_start_at,
          openingRangeEndAt: session.opening_range_end_at,
          signalWindowEndAt: session.signal_window_end_at,
          dataStatus: "VALID"
        },
        openingRange,
        currentCandle: replay.currentCandle,
        previousCandles: replay.previousCandles,
        spread: replay.currentCandle.spread ?? undefined,
        newsStatus: "CLEAR",
        riskStatus: "PERMITTED",
        configuration: configuration as any
      });
      const tradable = decision.status === "LONG SETUP READY" || decision.status === "SHORT SETUP READY";
      const scenarioMatched = decision.scenario === testCase.expected;
      const tradableMatched = tradable === testCase.tradable;
      return {
        code: testCase.code,
        label: testCase.label,
        expected: testCase.expected,
        actual: decision.scenario,
        expectedTradable: testCase.tradable,
        actualTradable: tradable,
        status: scenarioMatched && tradableMatched ? "PASS" : "FAIL",
        score: decision.favorabilityScore,
        grade: decision.favorabilityGrade,
        reason: scenarioMatched && tradableMatched ? "ORB replay behavior matches expectation." : `Expected ${testCase.expected} tradable=${testCase.tradable}, got ${decision.scenario} tradable=${tradable}.`
      };
    });
    const failed = cases.filter((row) => row.status !== "PASS");
    return {
      moduleCode: "orb_max_options",
      generatedAt: new Date().toISOString(),
      testMode: true,
      twelveDataCreditsUsed: 0,
      externalOrdersPlaced: 0,
      finalStatus: failed.length === 0 ? "PASS" : "FAIL",
      summary: {
        total: cases.length,
        passed: cases.length - failed.length,
        failed: failed.length,
        tradableCases: cases.filter((row) => row.expectedTradable).length,
        noTradeProtections: cases.filter((row) => !row.expectedTradable).length
      },
      cases
    };
  });

  app.post("/api/dev/orb-replay", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const body = request.body as { case?: ReplayCase };
    const replayCase = body.case ?? "BUY";
    const session = await ensureTodaySession(auth.tenantId);
    const version = await selectedStrategyVersion();
    const replay = buildReplay(replayCase, session);
    const openingRange = buildOpeningRange(replay.openingRangeCandles, 0.01, 1);
    const configuration = await getTenantOrbStrategyConfiguration(auth.tenantId, version.configuration_json);
    const decision = evaluateSetup({
      now: replay.currentCandle.timestampUtc,
      symbol: session.symbol,
      strategyVersionId: session.strategy_version_id,
      session: {
        id: session.id,
        symbol: session.symbol,
        strategyVersionId: session.strategy_version_id,
        sessionDate: session.session_date,
        sessionPreset: session.session_preset,
        state: "WAITING_FOR_SETUP",
        sessionStartAt: session.session_start_at,
        openingRangeEndAt: session.opening_range_end_at,
        signalWindowEndAt: session.signal_window_end_at,
        dataStatus: "VALID"
      },
      openingRange,
      currentCandle: replay.currentCandle,
      previousCandles: replay.previousCandles,
      spread: replay.currentCandle.spread ?? undefined,
      newsStatus: "CLEAR",
      riskStatus: "PERMITTED",
      configuration: configuration as any
    });
    const { rows } = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        decision.scenario,
        decision.direction,
        decision.status,
        new Date().toISOString(),
        session.signal_window_end_at,
        decision.entryPrice ?? null,
        decision.stopPrice ?? null,
        decision.targetPrice ?? null,
        `Replay ${replayCase}: ${decision.finalReason}`,
        decision.favorabilityScore,
        decision.favorabilityGrade,
        JSON.stringify(["Replay mode", ...decision.favorabilityReasons]),
        JSON.stringify({
          ...decision.scenarioFlags,
          replay: true,
          replayCase,
          replayExpectedScenario: replay.expectedScenario,
          replayMatchedExpectedScenario: decision.scenario === replay.expectedScenario
        }),
        auth.tenantId
      ]
    );
    for (const evaluation of decision.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          rows[0].id,
          evaluation.ruleCode,
          evaluation.name,
          evaluation.status,
          evaluation.blocking,
          evaluation.source,
          evaluation.actualValue == null ? null : String(evaluation.actualValue),
          evaluation.requiredValue == null ? null : String(evaluation.requiredValue),
          evaluation.explanation
        ]
      );
    }
    if (await canCreateTenantNotification(auth.tenantId)) {
      await query(
        `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
         VALUES ($4,$1,'ORB_REPLAY',$2,$3,'NORMAL')`,
        [
          `orb-replay-${rows[0].id}`,
          `ORB replay: ${decision.status}`,
          `${replayCase} produced ${decision.scenario}. No live API call, no real order.`,
          auth.tenantId
        ]
      );
    }
    const evaluations = await query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [rows[0].id]);
    return { setup: { ...rows[0], evaluations: evaluations.rows }, decision, replayCase, testMode: true };
  });

  app.post("/api/module1/launch-rehearsal", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const qaSuite = await buildOrbQaSuite(auth.tenantId);
    const session = await ensureTodaySession(auth.tenantId);
    const version = await selectedStrategyVersion();
    const replay = buildReplay("BUY", session);
    const openingRange = buildOpeningRange(replay.openingRangeCandles, 0.01, 1);
    const configuration = await getTenantOrbStrategyConfiguration(auth.tenantId, version.configuration_json);
    const decision = evaluateSetup({
      now: replay.currentCandle.timestampUtc,
      symbol: session.symbol,
      strategyVersionId: session.strategy_version_id,
      session: {
        id: session.id,
        symbol: session.symbol,
        strategyVersionId: session.strategy_version_id,
        sessionDate: session.session_date,
        sessionPreset: session.session_preset,
        state: "WAITING_FOR_SETUP",
        sessionStartAt: session.session_start_at,
        openingRangeEndAt: session.opening_range_end_at,
        signalWindowEndAt: session.signal_window_end_at,
        dataStatus: "VALID"
      },
      openingRange,
      currentCandle: replay.currentCandle,
      previousCandles: replay.previousCandles,
      spread: replay.currentCandle.spread ?? undefined,
      newsStatus: "CLEAR",
      riskStatus: "PERMITTED",
      configuration: configuration as any
    });
    const setupResult = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, module_code, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,'orb_max_options',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        decision.scenario,
        decision.direction,
        decision.status,
        new Date().toISOString(),
        session.signal_window_end_at,
        decision.entryPrice ?? null,
        decision.stopPrice ?? null,
        decision.targetPrice ?? null,
        `Module 1 launch rehearsal: ${decision.finalReason}`,
        decision.favorabilityScore,
        decision.favorabilityGrade,
        JSON.stringify(["Launch rehearsal", ...decision.favorabilityReasons]),
        JSON.stringify({
          ...decision.scenarioFlags,
          replay: true,
          rehearsal: true,
          replayCase: "BUY",
          replayExpectedScenario: replay.expectedScenario,
          replayMatchedExpectedScenario: decision.scenario === replay.expectedScenario
        }),
        auth.tenantId
      ]
    );
    const setup = setupResult.rows[0];
    for (const evaluation of decision.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          setup.id,
          evaluation.ruleCode,
          evaluation.name,
          evaluation.status,
          evaluation.blocking,
          evaluation.source,
          evaluation.actualValue == null ? null : String(evaluation.actualValue),
          evaluation.requiredValue == null ? null : String(evaluation.requiredValue),
          evaluation.explanation
        ]
      );
    }
    const trade = await openModuleReplayPaperTrade(setup, auth.tenantId, "MODULE1_REHEARSAL");
    const closedTrade = trade ? await closeModuleReplayPaperTrade(setup, auth.tenantId, "TP_HIT", "MODULE1_REHEARSAL") : null;
    if (await canCreateTenantNotification(auth.tenantId)) {
      await query(
        `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
         VALUES ($4,$1,'MODULE1_REHEARSAL_TEST',$2,$3,'NORMAL')
         ON CONFLICT (event_key) DO NOTHING`,
        [
          `module1-rehearsal-test-${setup.id}`,
          "Module 1 rehearsal notification",
          "ORB QA replay, paper trade, TP close, journal, audit, and isolation proof completed.",
          auth.tenantId
        ]
      );
    }
    const [journal, history, report, audit, notificationProof, isolation] = await Promise.all([
      query("SELECT count(*)::int AS count FROM journal_entries WHERE tenant_id = $1 AND setup_candidate_id = $2", [auth.tenantId, setup.id]),
      query("SELECT count(*)::int AS count FROM setup_candidates WHERE tenant_id = $1 AND module_code = 'orb_max_options' AND scenario_flags->>'rehearsal' = 'true'", [auth.tenantId]),
      moduleRehearsalReport(auth.tenantId, "orb_max_options"),
      moduleRehearsalAudit(auth.tenantId, "orb_max_options"),
      moduleRehearsalNotificationProof(auth.tenantId, "MODULE1_", setup.id),
      moduleIsolationProof(auth.tenantId, "orb_max_options")
    ]);
    const checklist = [
      launchCheck("QA_SUITE_PASS", "QA suite pass", qaSuite.finalStatus === "PASS", `${qaSuite.summary.passed}/${qaSuite.summary.total} replay cases passed.`),
      launchCheck("BUY_REPLAY_VALID", "BUY replay valid", decision.scenario === replay.expectedScenario && decision.status === "LONG SETUP READY", decision.finalReason),
      launchCheck("PAPER_TRADE_OPENED", "Paper trade opened", Boolean(trade?.id), trade?.id ?? "No paper trade opened."),
      launchCheck("TP_CLOSE_WORKS", "TP close works", closedTrade?.outcome === "WIN", closedTrade?.result_r == null ? "No close result." : `${Number(closedTrade.result_r).toFixed(2)}R`),
      launchCheck("JOURNAL_WRITTEN", "Journal written", Number(journal.rows[0]?.count ?? 0) > 0, `${journal.rows[0]?.count ?? 0} journal rows for rehearsal setup.`),
      launchCheck("HISTORY_VISIBLE", "Setup history visible", Number(history.rows[0]?.count ?? 0) > 0, `${history.rows[0]?.count ?? 0} Module 1 rehearsal setup rows.`),
      launchCheck("REPORT_READY", "Report ready", Number(report.paperTrades ?? 0) > 0, `${report.paperTrades ?? 0} Module 1 paper trades available for reporting.`),
      launchCheck("AUDIT_PASS", "Audit pass", audit.failedChecks === 0, `${audit.failedChecks} audit failures.`),
      launchCheck("NOTIFICATION_PROOF", "Notification proof", notificationProof.total >= 1, `${notificationProof.total} Module 1 notifications found.`),
      launchCheck("ISOLATION_PASS", "Isolation pass", isolation.mixedTrades === 0, `${isolation.mixedTrades} mixed Module 1 trade/session rows.`)
    ];
    const finalStatus = checklist.every((row) => row.status === "PASS") ? "GO" : "NO_GO";
    const result = {
      moduleCode: "orb_max_options",
      generatedAt: new Date().toISOString(),
      rehearsal: true,
      testMode: true,
      twelveDataCreditsUsed: 0,
      externalOrdersPlaced: 0,
      finalStatus,
      setup,
      trade: closedTrade ?? trade,
      qaSuite,
      checklist,
      report,
      audit,
      notificationProof,
      isolation,
      handoff: {
        expectedNextAction: finalStatus === "GO" ? "Module 1 ORB automation path is ready for live paper monitoring." : "Resolve NO GO checklist rows before trusting Module 1.",
        watchDuringSession: [
          "ORB high/low must lock from the configured New York opening range.",
          "Only valid breakout, retest, or sweep-reversal scenarios can open paper trades.",
          "Risk/TP/SL plan must exist before paper entry."
        ],
        manualTraderNotes: "No external execution is placed. Use Module 1 paper signal as the manual execution guide only."
      }
    };
    await query(
      `INSERT INTO module_launch_rehearsals (
        tenant_id, module_code, final_status, checklist_json, health_json, audit_json, dry_run_json, handoff_json
       ) VALUES ($1,'orb_max_options',$2,$3,$4,$5,$6,$7)`,
      [
        auth.tenantId,
        finalStatus,
        JSON.stringify(checklist),
        JSON.stringify({ report, notificationProof, isolation }),
        JSON.stringify(audit),
        JSON.stringify({ setupId: setup.id, tradeId: trade?.id ?? null, closedTrade }),
        JSON.stringify(result.handoff)
      ]
    );
    return result;
  });

  app.get("/api/module1/launch-rehearsals", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const rows = await query(
      `SELECT id, module_code, final_status, checklist_json, health_json, audit_json, dry_run_json, handoff_json, created_at
       FROM module_launch_rehearsals
       WHERE tenant_id = $1 AND module_code = 'orb_max_options'
       ORDER BY created_at DESC
       LIMIT 20`,
      [auth.tenantId]
    );
    return rows.rows;
  });

  app.get("/api/dev/module2-replay/cases", async () => ({
    cases: MODULE2_QA_CASES.map(({ code, label, expected, expectedStatus, opensPaperTrade }) => ({ code, label, expected, expectedStatus, opensPaperTrade }))
  }));

  app.post("/api/dev/module2-qa-suite", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const session = await ensureTodayModule2Session(auth.tenantId);
    const cases = MODULE2_QA_CASES.map((testCase) => {
      const replay = buildModule2Replay(testCase.code, session);
      const summary = module2ReplayQaSummary(replay, testCase);
      return {
        code: testCase.code,
        label: testCase.label,
        expected: testCase.expected,
        actual: replay.scenario,
        expectedStatus: testCase.expectedStatus,
        actualStatus: replay.status,
        expectedPaperEligible: testCase.opensPaperTrade,
        actualPaperEligible: summary.paperEligible,
        status: summary.passed ? "PASS" : "FAIL",
        hardRulesPassed: summary.hardRulesPassed,
        confirmationCount: summary.confirmationCount,
        qualityCount: summary.qualityCount,
        failureRule: testCase.failureRule ?? null,
        blockingFailure: summary.blockingFailure,
        reason: summary.reason
      };
    });
    const failed = cases.filter((row) => row.status !== "PASS");
    return {
      moduleCode: "high_probability_strategy_2",
      generatedAt: new Date().toISOString(),
      testMode: true,
      twelveDataCreditsUsed: 0,
      externalOrdersPlaced: 0,
      finalStatus: failed.length === 0 ? "PASS" : "FAIL",
      summary: {
        total: cases.length,
        passed: cases.length - failed.length,
        failed: failed.length,
        validSignals: cases.filter((row) => row.expectedPaperEligible).length,
        noTradeProtections: cases.filter((row) => !row.expectedPaperEligible).length
      },
      cases
    };
  });

  app.post("/api/dev/module2-replay", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const body = request.body as { case?: Module2ReplayCase; openPaperTrade?: boolean };
    const replayCase = body.case ?? "BUY";
    const session = await ensureTodayModule2Session(auth.tenantId);
    const replay = buildModule2Replay(replayCase, session);
    const timestamp = new Date().toISOString();
    const { rows } = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, module_code, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,'high_probability_strategy_2',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        replay.scenario,
        replay.direction,
        replay.status,
        timestamp,
        session.signal_window_end_at,
        replay.entryPrice ?? null,
        replay.stopPrice ?? null,
        replay.targetPrice ?? null,
        `Module 2 replay ${replayCase}: ${replay.finalReason}`,
        replay.score,
        replay.grade,
        JSON.stringify(replay.reasons),
        JSON.stringify({
          ...replay.flags,
          replay: true,
          replayCase,
          replayExpectedScenario: replay.expectedScenario,
          replayMatchedExpectedScenario: replay.scenario === replay.expectedScenario || replay.flags.state === replay.expectedScenario,
          chartSnapshotCandles: replay.snapshotCandles
        }),
        auth.tenantId
      ]
    );
    for (const evaluation of replay.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          rows[0].id,
          evaluation.ruleCode,
          evaluation.name,
          evaluation.status,
          evaluation.blocking,
          evaluation.source,
          evaluation.actualValue == null ? null : String(evaluation.actualValue),
          evaluation.requiredValue == null ? null : String(evaluation.requiredValue),
          evaluation.explanation
        ]
      );
    }
    if (await canCreateTenantNotification(auth.tenantId)) {
      await query(
        `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
         VALUES ($4,$1,'MODULE2_REPLAY',$2,$3,'NORMAL')`,
        [
          `module2-replay-${rows[0].id}`,
          `Module 2 replay: ${replay.status}`,
          `${replayCase} produced ${replay.scenario}. No Twelve Data call, no real order.`,
          auth.tenantId
        ]
      );
    }
    const trade = body.openPaperTrade && replay.status.includes("SETUP READY")
      ? await openModule2ReplayPaperTrade(rows[0], auth.tenantId)
      : null;
    const evaluations = await query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [rows[0].id]);
    return { setup: { ...rows[0], evaluations: evaluations.rows }, trade, replayCase, testMode: true };
  });

  app.get("/api/dev/module3-replay/cases", async () => ({
    cases: MODULE3_QA_CASES.map(({ code, label, expected, expectedStatus, opensPaperTrade }) => ({ code, label, expected, expectedStatus, opensPaperTrade }))
  }));

  app.post("/api/dev/module3-qa-suite", async (request) => {
    const auth = await requireTenantModule(request, "strategy_lab_3");
    const session = await ensureTodayModule3Session(auth.tenantId);
    const cases = MODULE3_QA_CASES.map((testCase) => {
      const replay = buildModule3Replay(testCase.code, session);
      const blockingFailure = replay.evaluations.find((row) => row.blocking && row.status !== "PASS")?.ruleCode ?? null;
      const paperEligible = ["LONG SETUP READY", "SHORT SETUP READY"].includes(replay.status) && replay.evaluations.filter((row) => row.blocking).every((row) => row.status === "PASS");
      const passed =
        replay.scenario === testCase.expected &&
        replay.status === testCase.expectedStatus &&
        paperEligible === testCase.opensPaperTrade &&
        (!testCase.failureRule || blockingFailure === testCase.failureRule);
      return {
        code: testCase.code,
        label: testCase.label,
        expected: testCase.expected,
        actual: replay.scenario,
        expectedStatus: testCase.expectedStatus,
        actualStatus: replay.status,
        expectedPaperEligible: testCase.opensPaperTrade,
        actualPaperEligible: paperEligible,
        status: passed ? "PASS" : "FAIL",
        failureRule: testCase.failureRule ?? null,
        blockingFailure,
        reason: replay.finalReason
      };
    });
    const failed = cases.filter((row) => row.status !== "PASS");
    return {
      moduleCode: "strategy_lab_3",
      generatedAt: new Date().toISOString(),
      testMode: true,
      twelveDataCreditsUsed: 0,
      externalOrdersPlaced: 0,
      finalStatus: failed.length === 0 ? "PASS" : "FAIL",
      summary: {
        total: cases.length,
        passed: cases.length - failed.length,
        failed: failed.length,
        validSignals: cases.filter((row) => row.expectedPaperEligible).length,
        noTradeProtections: cases.filter((row) => !row.expectedPaperEligible).length
      },
      cases
    };
  });

  app.post("/api/dev/module3-replay", async (request) => {
    const auth = await requireTenantModule(request, "strategy_lab_3");
    const body = request.body as { case?: Module3ReplayCase; openPaperTrade?: boolean };
    const replayCase = body.case ?? "BUY";
    const session = await ensureTodayModule3Session(auth.tenantId);
    const replay = buildModule3Replay(replayCase, session);
    const timestamp = new Date().toISOString();
    const { rows } = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, module_code, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,'strategy_lab_3',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        replay.scenario,
        replay.direction,
        replay.status,
        timestamp,
        session.signal_window_end_at,
        replay.entryPrice ?? null,
        replay.stopPrice ?? null,
        replay.targetPrice ?? null,
        `Module 3 replay ${replayCase}: ${replay.finalReason}`,
        replay.score,
        replay.grade,
        JSON.stringify(replay.reasons),
        JSON.stringify({
          ...replay.flags,
          replay: true,
          replayCase,
          replayExpectedScenario: replay.expectedScenario,
          replayMatchedExpectedScenario: replay.scenario === replay.expectedScenario,
          chartSnapshotCandles: replay.snapshotCandles
        }),
        auth.tenantId
      ]
    );
    for (const evaluation of replay.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          rows[0].id,
          evaluation.ruleCode,
          evaluation.name,
          evaluation.status,
          evaluation.blocking,
          evaluation.source,
          evaluation.actualValue == null ? null : String(evaluation.actualValue),
          evaluation.requiredValue == null ? null : String(evaluation.requiredValue),
          evaluation.explanation
        ]
      );
    }
    if (await canCreateTenantNotification(auth.tenantId)) {
      await query(
        `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
         VALUES ($4,$1,'MODULE3_REPLAY',$2,$3,'NORMAL')`,
        [
          `module3-replay-${rows[0].id}`,
          `Module 3 replay: ${replay.status}`,
          `${replayCase} produced ${replay.scenario}. No Twelve Data call, no real order.`,
          auth.tenantId
        ]
      );
    }
    const trade = body.openPaperTrade && replay.status.includes("SETUP READY")
      ? await openModuleReplayPaperTrade(rows[0], auth.tenantId, "MODULE3_QA")
      : null;
    const evaluations = await query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [rows[0].id]);
    return { setup: { ...rows[0], evaluations: evaluations.rows }, trade, replayCase, testMode: true };
  });

  app.post("/api/module3/launch-rehearsal", async (request) => {
    const auth = await requireTenantModule(request, "strategy_lab_3");
    const qaSuite = await buildModule3QaSuite(auth.tenantId);
    const session = await ensureTodayModule3Session(auth.tenantId);
    const replay = buildModule3Replay("BUY", session);
    const timestamp = new Date().toISOString();
    const setupResult = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, module_code, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,'strategy_lab_3',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        replay.scenario,
        replay.direction,
        replay.status,
        timestamp,
        session.signal_window_end_at,
        replay.entryPrice ?? null,
        replay.stopPrice ?? null,
        replay.targetPrice ?? null,
        `Module 3 launch rehearsal: ${replay.finalReason}`,
        replay.score,
        replay.grade,
        JSON.stringify(replay.reasons),
        JSON.stringify({
          ...replay.flags,
          replay: true,
          rehearsal: true,
          replayCase: "BUY",
          replayExpectedScenario: replay.expectedScenario,
          replayMatchedExpectedScenario: replay.scenario === replay.expectedScenario,
          chartSnapshotCandles: replay.snapshotCandles
        }),
        auth.tenantId
      ]
    );
    const setup = setupResult.rows[0];
    for (const evaluation of replay.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          setup.id,
          evaluation.ruleCode,
          evaluation.name,
          evaluation.status,
          evaluation.blocking,
          evaluation.source,
          evaluation.actualValue == null ? null : String(evaluation.actualValue),
          evaluation.requiredValue == null ? null : String(evaluation.requiredValue),
          evaluation.explanation
        ]
      );
    }
    const trade = await openModuleReplayPaperTrade(setup, auth.tenantId, "MODULE3_REHEARSAL");
    const closedTrade = trade ? await closeModuleReplayPaperTrade(setup, auth.tenantId, "TP_HIT", "MODULE3_REHEARSAL") : null;
    if (await canCreateTenantNotification(auth.tenantId)) {
      await query(
        `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
         VALUES ($4,$1,'MODULE3_REPLAY',$2,$3,'NORMAL')
         ON CONFLICT (event_key) DO NOTHING`,
        [
          `module3-replay-${setup.id}`,
          "Module 3 rehearsal BUY replay",
          "Module 3 rehearsal produced a valid BUY replay without Twelve Data credits or real orders.",
          auth.tenantId
        ]
      );
      await query(
        `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
         VALUES ($4,$1,'MODULE3_REHEARSAL_TEST',$2,$3,'NORMAL')
         ON CONFLICT (event_key) DO NOTHING`,
        [
          `module3-rehearsal-test-${setup.id}`,
          "Module 3 rehearsal notification",
          "Module 3 QA replay, paper trade, TP close, journal, audit, and isolation proof completed.",
          auth.tenantId
        ]
      );
    }
    const [journal, history, report, audit, notificationProof, isolation] = await Promise.all([
      query("SELECT count(*)::int AS count FROM journal_entries WHERE tenant_id = $1 AND setup_candidate_id = $2", [auth.tenantId, setup.id]),
      query("SELECT count(*)::int AS count FROM setup_candidates WHERE tenant_id = $1 AND module_code = 'strategy_lab_3' AND scenario_flags->>'rehearsal' = 'true'", [auth.tenantId]),
      moduleRehearsalReport(auth.tenantId, "strategy_lab_3"),
      moduleRehearsalAudit(auth.tenantId, "strategy_lab_3"),
      module3RehearsalNotificationProof(auth.tenantId, setup.id),
      moduleIsolationProof(auth.tenantId, "strategy_lab_3")
    ]);
    const checklist = [
      launchCheck("QA_SUITE_PASS", "QA suite pass", qaSuite.finalStatus === "PASS", `${qaSuite.summary.passed}/${qaSuite.summary.total} replay cases passed.`),
      launchCheck("BUY_REPLAY_VALID", "BUY replay valid", replay.scenario === "NY_VWAP_OPENING_DRIVE_PULLBACK_BUY" && replay.status === "LONG SETUP READY", replay.finalReason),
      launchCheck("PAPER_TRADE_OPENED", "Paper trade opened", Boolean(trade?.id), trade?.id ?? "No paper trade opened."),
      launchCheck("TP_CLOSE_WORKS", "TP close works", closedTrade?.outcome === "WIN", closedTrade?.result_r == null ? "No close result." : `${Number(closedTrade.result_r).toFixed(2)}R`),
      launchCheck("JOURNAL_WRITTEN", "Journal written", Number(journal.rows[0]?.count ?? 0) > 0, `${journal.rows[0]?.count ?? 0} journal rows for rehearsal setup.`),
      launchCheck("HISTORY_VISIBLE", "Setup history visible", Number(history.rows[0]?.count ?? 0) > 0, `${history.rows[0]?.count ?? 0} Module 3 rehearsal setup rows.`),
      launchCheck("REPORT_READY", "Report ready", Number(report.paperTrades ?? 0) > 0, `${report.paperTrades ?? 0} Module 3 paper trades available for reporting.`),
      launchCheck("AUDIT_PASS", "Audit pass", audit.failedChecks === 0, `${audit.failedChecks} audit failures.`),
      launchCheck("NOTIFICATION_PROOF", "Notification proof", notificationProof.total >= 2, `${notificationProof.total} Module 3 QA/rehearsal notifications found.`),
      launchCheck("ISOLATION_PASS", "Isolation pass", isolation.mixedTrades === 0, `${isolation.mixedTrades} mixed Module 3 trade/session rows.`)
    ];
    const finalStatus = checklist.every((row) => row.status === "PASS") ? "GO" : "NO_GO";
    const result = {
      moduleCode: "strategy_lab_3",
      generatedAt: new Date().toISOString(),
      rehearsal: true,
      testMode: true,
      twelveDataCreditsUsed: 0,
      externalOrdersPlaced: 0,
      finalStatus,
      setup,
      trade: closedTrade ?? trade,
      qaSuite,
      checklist,
      report,
      audit,
      notificationProof,
      isolation,
      handoff: {
        expectedNextAction: finalStatus === "GO" ? "Module 3 automation path is ready for live paper monitoring." : "Resolve NO GO checklist rows before trusting Module 3.",
        watchDuringSession: [
          "Opening drive must complete and be strong.",
          "Price must stay aligned with VWAP.",
          "Pullback zone and confirmation candle must match.",
          "Paper trade only opens after the Module 3 checklist passes."
        ],
        manualTraderNotes: "No external execution is placed. Use Module 3 paper signal as the manual execution guide only."
      }
    };
    await query(
      `INSERT INTO module_launch_rehearsals (
        tenant_id, module_code, final_status, checklist_json, health_json, audit_json, dry_run_json, handoff_json
       ) VALUES ($1,'strategy_lab_3',$2,$3,$4,$5,$6,$7)`,
      [
        auth.tenantId,
        finalStatus,
        JSON.stringify(checklist),
        JSON.stringify({ report, notificationProof, isolation }),
        JSON.stringify(audit),
        JSON.stringify({ setupId: setup.id, tradeId: trade?.id ?? null, closedTrade }),
        JSON.stringify(result.handoff)
      ]
    );
    return result;
  });

  app.get("/api/module3/launch-rehearsals", async (request) => {
    const auth = await requireTenantModule(request, "strategy_lab_3");
    const rows = await query(
      `SELECT id, module_code, final_status, checklist_json, health_json, audit_json, dry_run_json, handoff_json, created_at
       FROM module_launch_rehearsals
       WHERE tenant_id = $1 AND module_code = 'strategy_lab_3'
       ORDER BY created_at DESC
       LIMIT 20`,
      [auth.tenantId]
    );
    return rows.rows;
  });

  app.post("/api/dev/test-signal", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const body = request.body as { direction?: "LONG" | "SHORT" };
    const direction = body.direction === "SHORT" ? "SHORT" : "LONG";
    const session = await ensureTodaySession(auth.tenantId);
    const latest = await query(
      `SELECT timestamp_utc, close
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2
       ORDER BY timestamp_utc DESC
       LIMIT 1`,
      [session.symbol, Number(session.signal_timeframe_minutes ?? 15)]
    );
    const close = Number(latest.rows[0]?.close ?? 4050);
    const timestamp = new Date().toISOString();
    const stopDistance = 5;
    const targetDistance = 10;
    const entry = close;
    const stop = direction === "LONG" ? entry - stopDistance : entry + stopDistance;
    const target = direction === "LONG" ? entry + targetDistance : entry - targetDistance;
    const status = direction === "LONG" ? "LONG SETUP READY" : "SHORT SETUP READY";
    const { rows } = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($14,$1,$2,$3,'QA_TEST_SIGNAL',$4,$5,$6,$7,$8,$9,$10,$11,100,'QA',$12,$13)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        direction,
        status,
        timestamp,
        session.signal_window_end_at,
        entry,
        stop,
        target,
        `QA test ${direction === "LONG" ? "BUY" : "SELL"} signal. This bypasses ORB rules for notification and UI testing only.`,
        JSON.stringify(["QA test signal", "ORB scenario bypassed", "Do not use for trading decisions"]),
        JSON.stringify({ qaTest: true, bypassedOrbRules: true }),
        auth.tenantId
      ]
    );
    await query(
      `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
       VALUES ($4,$1,'QA_TEST_SIGNAL',$2,$3,'HIGH')`,
      [
        `qa-test-signal-${rows[0].id}`,
        `QA ${direction === "LONG" ? "BUY" : "SELL"} test signal`,
        `Test ${direction === "LONG" ? "BUY" : "SELL"} at ${entry.toFixed(2)}. This is not a valid ORB setup.`,
        auth.tenantId
      ]
    );
    return { setup: rows[0], testMode: true };
  });

  app.post("/api/dev/test-signal/clear", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const { rowCount } = await query("UPDATE setup_candidates SET status = 'TEST_CLEARED' WHERE tenant_id = $1 AND (scenario = 'QA_TEST_SIGNAL' OR scenario_flags->>'replay' = 'true')", [auth.tenantId]);
    return { cleared: rowCount ?? 0 };
  });

  app.post("/api/setups/evaluate", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const body = request.body as { sessionId: string; currentCandle: any; previousCandles: any[]; spread?: number; newsStatus?: any };
    const sessionResult = await query(
      `SELECT ts.*, orr.status AS range_status, orr.high, orr.low, orr.midpoint, orr.width, orr.width_ticks,
        sv.configuration_json, rp.*
       FROM trading_sessions ts
       JOIN opening_ranges orr ON orr.session_id = ts.id
       JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
       JOIN risk_profiles rp ON rp.is_active = true
       WHERE ts.id = $1 AND ts.tenant_id = $2 AND rp.tenant_id = $2
       LIMIT 1`,
      [body.sessionId, auth.tenantId]
    );
    const row = sessionResult.rows[0] as any;
    const openingRange = {
      status: row.range_status,
      high: Number(row.high),
      low: Number(row.low),
      midpoint: Number(row.midpoint),
      width: Number(row.width),
      widthTicks: Number(row.width_ticks),
      sourceCandleCount: 3,
      dataQualityStatus: "VALID"
    };
    const stop = body.currentCandle.close > openingRange.high ? openingRange.low : openingRange.high;
    const entry = Number(body.currentCandle.close);
    const target = entry > Number(stop) ? entry + Math.abs(entry - Number(stop)) * 2 : entry - Math.abs(entry - Number(stop)) * 2;
    const risk = calculateRisk({
      accountBalance: Number(row.account_balance),
      accountEquity: Number(row.account_equity),
      riskPerTradePercent: Number(row.risk_per_trade_percent),
      entry,
      stop: Number(stop),
      target,
      contractSize: XAUUSD_PAPER_SPEC.contractSize,
      tickSize: XAUUSD_PAPER_SPEC.tickSize,
      tickValue: XAUUSD_PAPER_SPEC.tickValue,
      minimumLot: XAUUSD_PAPER_SPEC.minimumLot,
      lotStep: XAUUSD_PAPER_SPEC.lotStep,
      maximumLot: XAUUSD_PAPER_SPEC.maximumLot,
      spread: Number(body.spread ?? 0),
      commissionPerLot: XAUUSD_PAPER_SPEC.commissionPerLot,
      minimumRewardToRisk: Number(row.minimum_reward_to_risk),
      maximumDailyLossPercent: Number(row.maximum_daily_loss_percent),
      maximumWeeklyLossPercent: Number(row.maximum_weekly_loss_percent)
    });
    const configuration = await getTenantOrbStrategyConfiguration(auth.tenantId, row.configuration_json);
    const decision = evaluateSetup({
      now: body.currentCandle.timestampUtc,
      symbol: row.symbol,
      strategyVersionId: row.strategy_version_id,
      session: {
        id: row.id,
        symbol: row.symbol,
        strategyVersionId: row.strategy_version_id,
        sessionDate: row.session_date,
        sessionPreset: row.session_preset,
        state: row.state,
        sessionStartAt: row.session_start_at,
        openingRangeEndAt: row.opening_range_end_at,
        signalWindowEndAt: row.signal_window_end_at,
        dataStatus: row.data_status
      },
      openingRange,
      currentCandle: body.currentCandle,
      previousCandles: body.previousCandles ?? [],
      spread: body.spread,
      newsStatus: body.newsStatus ?? "CLEAR",
      riskStatus: risk.status,
      configuration: configuration as any
    });
    const saved = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        body.sessionId,
        row.strategy_version_id,
        row.symbol,
        decision.scenario,
        decision.direction,
        decision.status,
        body.currentCandle.timestampUtc,
        row.signal_window_end_at,
        decision.entryPrice ?? null,
        decision.stopPrice ?? null,
        decision.targetPrice ?? null,
        decision.finalReason,
        decision.favorabilityScore,
        decision.favorabilityGrade,
        JSON.stringify(decision.favorabilityReasons),
        JSON.stringify(decision.scenarioFlags),
        auth.tenantId
      ]
    );
    for (const evaluation of decision.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          saved.rows[0].id,
          evaluation.ruleCode,
          evaluation.name,
          evaluation.status,
          evaluation.blocking,
          evaluation.source,
          evaluation.actualValue == null ? null : String(evaluation.actualValue),
          evaluation.requiredValue == null ? null : String(evaluation.requiredValue),
          evaluation.explanation
        ]
      );
    }
    await query("INSERT INTO risk_events (setup_candidate_id, status, reasons, calculation) VALUES ($1,$2,$3,$4)", [
      saved.rows[0].id,
      risk.status,
      JSON.stringify(risk.reasons),
      JSON.stringify(risk)
    ]);
    return { setup: saved.rows[0], decision, risk };
  });

  app.get("/api/setups/:id", async (request) => {
    const { id } = request.params as { id: string };
    const scope = await query("SELECT tenant_id, module_code FROM setup_candidates WHERE id = $1", [id]);
    const scoped = scope.rows[0] as any;
    if (!scoped) return null;
    const auth = await requireTenantModule(request, scoped.module_code ?? "orb_max_options");
    if (scoped.tenant_id !== auth.tenantId) return null;
    const setup = await query("SELECT * FROM setup_candidates WHERE id = $1 AND tenant_id = $2", [id, auth.tenantId]);
    const evaluations = await query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [id]);
    return { ...setup.rows[0], evaluations: evaluations.rows };
  });

  for (const [path, status] of [
    ["confirm", "TRADE_PLANNED"],
    ["skip", "SKIPPED"],
    ["reject", "REJECTED"],
    ["mark-missed", "MISSED"]
  ] as const) {
    app.post(`/api/setups/:id/${path}`, async (request) => {
      const { id } = request.params as { id: string };
      const scope = await query("SELECT tenant_id, module_code FROM setup_candidates WHERE id = $1", [id]);
      const scoped = scope.rows[0] as any;
      if (!scoped) return null;
      const auth = await requireTenantModule(request, scoped.module_code ?? "orb_max_options");
      if (scoped.tenant_id !== auth.tenantId) return null;
      const { rows } = await query("UPDATE setup_candidates SET status = $2 WHERE id = $1 AND tenant_id = $3 RETURNING *", [id, status, auth.tenantId]);
      return rows[0];
    });
  }
}

function setupRecommendation(setup: any) {
  if (setup.direction === "LONG" && ["LONG SETUP READY", "PAPER_TRADE_OPENED", "TRADE_PLANNED"].includes(setup.status)) return "BUY";
  if (setup.direction === "SHORT" && ["SHORT SETUP READY", "PAPER_TRADE_OPENED", "TRADE_PLANNED"].includes(setup.status)) return "SELL";
  if (["NO TRADE", "BLOCKED", "SETUP_INVALIDATED"].includes(setup.status)) return "NO TRADE";
  return "WAIT";
}

function launchCheck(code: string, label: string, passed: boolean, detail: string) {
  return { code, label, status: passed ? "PASS" : "FAIL", detail };
}

async function closeModuleReplayPaperTrade(setup: any, tenantId: string | null, event: "TP_HIT" | "SL_HIT" | "MANUAL_CLOSE", eventPrefix: string) {
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
  if (!trade) return null;
  const exit = event === "TP_HIT" ? Number(trade.actual_target) : event === "SL_HIT" ? Number(trade.actual_stop) : Number(trade.actual_entry);
  const entry = Number(trade.actual_entry);
  const stop = Number(trade.actual_stop);
  const multiplier = trade.direction === "SHORT" ? -1 : 1;
  const resultR = Math.abs(entry - stop) > 0 ? ((exit - entry) * multiplier) / Math.abs(entry - stop) : 0;
  const outcome = resultR > 0 ? "WIN" : resultR < 0 ? "LOSS" : "BREAKEVEN";
  const closed = await query(
    "UPDATE trades SET actual_exit = $2, result_r = $3, outcome = $4, closed_at = now() WHERE id = $1 RETURNING *",
    [trade.id, resultR > 0 ? trade.actual_target : exit, resultR, outcome]
  );
  await query("UPDATE trade_plans SET status = 'CLOSED' WHERE id = $1", [trade.plan_id]);
  await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,$2,$3)", [trade.id, `${eventPrefix}_${event}`, { setupId: setup.id, resultR, outcome, replay: true, moduleCode: setup.module_code }]);
  await query(
    `INSERT INTO journal_entries (
      tenant_id, setup_candidate_id, trade_id, session_id, decision, lesson, process_grade, outcome
    ) VALUES ($1,$2,$3,$4,$5,$6,'QA',$7)`,
    [tenantId, setup.id, trade.id, setup.session_id, `${eventPrefix}_${event}`, "Module 3 rehearsal verified the paper-trade close path.", outcome]
  );
  return closed.rows[0];
}

async function moduleRehearsalReport(tenantId: string | null, moduleCode: string) {
  const result = await query(
    `SELECT
       count(t.id)::int AS paper_trades,
       count(t.id) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
       count(t.id) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
       COALESCE(sum(t.result_r), 0)::float AS total_r
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.tenant_id = $1 AND sc.module_code = $2`,
    [tenantId, moduleCode]
  );
  const row = result.rows[0] ?? {};
  return {
    paperTrades: Number(row.paper_trades ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    totalR: Number(row.total_r ?? 0)
  };
}

async function moduleRehearsalAudit(tenantId: string | null, moduleCode: string) {
  const [invalidTrades, mixedTrades, duplicateProduction] = await Promise.all([
    query(
      `SELECT count(t.id)::int AS count
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.status NOT IN ('PAPER_TRADE_OPENED','TRADE_PLANNED','LONG SETUP READY','SHORT SETUP READY')
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
      [tenantId, moduleCode]
    ),
    query(
      `SELECT count(*)::int AS count
       FROM trade_plans tp
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       JOIN trading_sessions ts ON ts.id = sc.session_id
       WHERE sc.tenant_id = $1 AND sc.module_code = $2 AND ts.module_code <> $2`,
      [tenantId, moduleCode]
    ),
    query(
      `SELECT count(*)::int AS count
       FROM (
         SELECT sc.session_id
         FROM trades t
         JOIN trade_plans tp ON tp.id = t.trade_plan_id
         JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
         WHERE sc.tenant_id = $1
           AND sc.module_code = $2
           AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         GROUP BY sc.session_id
         HAVING count(t.id) > 1
       ) duplicate_sessions`,
      [tenantId, moduleCode]
    )
  ]);
  const failedChecks = [invalidTrades, mixedTrades, duplicateProduction].filter((item) => Number(item.rows[0]?.count ?? 0) > 0).length;
  return {
    status: failedChecks === 0 ? "PASS" : "FAIL",
    failedChecks,
    invalidTrades: Number(invalidTrades.rows[0]?.count ?? 0),
    mixedTrades: Number(mixedTrades.rows[0]?.count ?? 0),
    duplicateProduction: Number(duplicateProduction.rows[0]?.count ?? 0)
  };
}

async function module3RehearsalNotificationProof(tenantId: string | null, setupId: string) {
  const result = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE event_type = 'MODULE3_REPLAY')::int AS replay,
            count(*) FILTER (WHERE event_type = 'MODULE3_REHEARSAL_TEST')::int AS rehearsal
     FROM notifications
     WHERE tenant_id = $1
       AND (event_key = $2 OR event_key LIKE 'module3-rehearsal-test-%' OR event_type LIKE 'MODULE3_%')`,
    [tenantId, `module3-replay-${setupId}`]
  );
  return {
    total: Number(result.rows[0]?.total ?? 0),
    replay: Number(result.rows[0]?.replay ?? 0),
    rehearsal: Number(result.rows[0]?.rehearsal ?? 0)
  };
}

async function moduleRehearsalNotificationProof(tenantId: string | null, eventTypePrefix: string, setupId: string) {
  const result = await query(
    `SELECT count(*)::int AS total
     FROM notifications
     WHERE tenant_id = $1
       AND (event_key LIKE $2 OR event_key LIKE $3 OR event_type LIKE $4)`,
    [tenantId, `%${setupId}`, `module1-rehearsal-test-%`, `${eventTypePrefix}%`]
  );
  return {
    total: Number(result.rows[0]?.total ?? 0)
  };
}

async function moduleIsolationProof(tenantId: string | null, moduleCode: string) {
  const result = await query(
    `SELECT count(*)::int AS mixed_trades
     FROM trade_plans tp
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     JOIN trading_sessions ts ON ts.id = sc.session_id
     WHERE sc.tenant_id = $1 AND sc.module_code = $2 AND ts.module_code <> $2`,
    [tenantId, moduleCode]
  );
  return {
    mixedTrades: Number(result.rows[0]?.mixed_trades ?? 0),
    sharedFeedOnly: true
  };
}

async function buildOrbQaSuite(tenantId: string | null) {
  const session = await ensureTodaySession(tenantId);
  const version = await selectedStrategyVersion();
  const configuration = await getTenantOrbStrategyConfiguration(tenantId, version.configuration_json);
  const cases = ORB_QA_CASES.map((testCase) => {
    const replay = buildReplay(testCase.code, session);
    const openingRange = buildOpeningRange(replay.openingRangeCandles, 0.01, 1);
    const decision = evaluateSetup({
      now: replay.currentCandle.timestampUtc,
      symbol: session.symbol,
      strategyVersionId: session.strategy_version_id,
      session: {
        id: session.id,
        symbol: session.symbol,
        strategyVersionId: session.strategy_version_id,
        sessionDate: session.session_date,
        sessionPreset: session.session_preset,
        state: "WAITING_FOR_SETUP",
        sessionStartAt: session.session_start_at,
        openingRangeEndAt: session.opening_range_end_at,
        signalWindowEndAt: session.signal_window_end_at,
        dataStatus: "VALID"
      },
      openingRange,
      currentCandle: replay.currentCandle,
      previousCandles: replay.previousCandles,
      spread: replay.currentCandle.spread ?? undefined,
      newsStatus: "CLEAR",
      riskStatus: "PERMITTED",
      configuration: configuration as any
    });
    const tradable = decision.status === "LONG SETUP READY" || decision.status === "SHORT SETUP READY";
    const scenarioMatched = decision.scenario === testCase.expected;
    const tradableMatched = tradable === testCase.tradable;
    return {
      code: testCase.code,
      label: testCase.label,
      expected: testCase.expected,
      actual: decision.scenario,
      expectedTradable: testCase.tradable,
      actualTradable: tradable,
      status: scenarioMatched && tradableMatched ? "PASS" : "FAIL",
      score: decision.favorabilityScore,
      grade: decision.favorabilityGrade,
      reason: scenarioMatched && tradableMatched ? "ORB replay behavior matches expectation." : `Expected ${testCase.expected} tradable=${testCase.tradable}, got ${decision.scenario} tradable=${tradable}.`
    };
  });
  const failed = cases.filter((row) => row.status !== "PASS");
  return {
    moduleCode: "orb_max_options",
    generatedAt: new Date().toISOString(),
    testMode: true,
    twelveDataCreditsUsed: 0,
    externalOrdersPlaced: 0,
    finalStatus: failed.length === 0 ? "PASS" : "FAIL",
    summary: {
      total: cases.length,
      passed: cases.length - failed.length,
      failed: failed.length,
      tradableCases: cases.filter((row) => row.expectedTradable).length,
      noTradeProtections: cases.filter((row) => !row.expectedTradable).length
    },
    cases
  };
}

async function buildModule3QaSuite(tenantId: string | null) {
  const session = await ensureTodayModule3Session(tenantId);
  const cases = MODULE3_QA_CASES.map((testCase) => {
    const replay = buildModule3Replay(testCase.code, session);
    const statusByRule = new Map<string, string>(replay.evaluations.map((row) => [String(row.ruleCode), String(row.status)]));
    const hardRulesPassed = ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "OPENING_DRIVE_COMPLETE", "OPENING_DRIVE_STRONG", "VWAP_ALIGNMENT", "PULLBACK_ZONE_READY", "PULLBACK_ZONE_TOUCHED"].every((code) => statusByRule.get(code) === "PASS");
    const entryTriggerPassed = statusByRule.get("CONFIRMATION_CANDLE") === "PASS";
    const safetyRulesPassed = ["QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "SIGNAL_SCORE"].every((code) => statusByRule.get(code) === "PASS");
    const blockingFailure = replay.evaluations.find((row) => row.blocking && row.status !== "PASS")?.ruleCode ?? null;
    const paperEligible = ["LONG SETUP READY", "SHORT SETUP READY"].includes(replay.status) && hardRulesPassed && entryTriggerPassed && safetyRulesPassed;
    const passed =
      replay.scenario === testCase.expected &&
      replay.status === testCase.expectedStatus &&
      paperEligible === testCase.opensPaperTrade &&
      (!testCase.failureRule || blockingFailure === testCase.failureRule);
    return {
      code: testCase.code,
      label: testCase.label,
      expected: testCase.expected,
      actual: replay.scenario,
      expectedStatus: testCase.expectedStatus,
      actualStatus: replay.status,
      expectedPaperEligible: testCase.opensPaperTrade,
      actualPaperEligible: paperEligible,
      hardRulesPassed,
      entryTriggerPassed,
      safetyRulesPassed,
      status: passed ? "PASS" : "FAIL",
      failureRule: testCase.failureRule ?? null,
      blockingFailure,
      reason: replay.finalReason
    };
  });
  const failed = cases.filter((row) => row.status !== "PASS");
  return {
    moduleCode: "strategy_lab_3",
    generatedAt: new Date().toISOString(),
    testMode: true,
    twelveDataCreditsUsed: 0,
    externalOrdersPlaced: 0,
    finalStatus: failed.length === 0 ? "PASS" : "FAIL",
    summary: {
      total: cases.length,
      passed: cases.length - failed.length,
      failed: failed.length,
      validSignals: cases.filter((row) => row.expectedPaperEligible).length,
      noTradeProtections: cases.filter((row) => !row.expectedPaperEligible).length
    },
    cases
  };
}

async function selectedStrategyVersion() {
  const versionResult = await query("SELECT * FROM strategy_versions WHERE id = (SELECT selected_strategy_version_id FROM user_preferences LIMIT 1)");
  return versionResult.rows[0] as any;
}

async function ensureTodaySession(tenantId: string | null) {
  const version = await selectedStrategyVersion();
  const sessionDate = newYorkDate();
  const existing = await query(
    `SELECT ts.*, sv.signal_timeframe_minutes
     FROM trading_sessions ts
     JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
     WHERE ts.symbol = 'XAUUSD'
       AND ts.strategy_version_id = $1
       AND ts.session_date = $2
       AND ts.session_preset = 'NY_0915'
       AND ts.tenant_id = $3
     ORDER BY ts.created_at DESC
     LIMIT 1`,
    [version.id, sessionDate, tenantId]
  );
  if (existing.rows[0]) return existing.rows[0] as any;
  const times = sessionTimesForDate(sessionDate, version.session_start, version.opening_range_minutes, version.trade_window_end);
  const { rows } = await query(
    `INSERT INTO trading_sessions (
      tenant_id, user_id, symbol, strategy_version_id, session_date, session_preset, state,
      session_start_at, opening_range_end_at, signal_window_end_at
    ) VALUES (
      $6, (SELECT id FROM users WHERE tenant_id = $6 LIMIT 1), 'XAUUSD', $1, $2, 'NY_0915', 'PRE_SESSION', $3, $4, $5
    ) RETURNING *`,
    [version.id, sessionDate, times.sessionStartAt, times.openingRangeEndAt, times.signalWindowEndAt, tenantId]
  );
  return { ...rows[0], signal_timeframe_minutes: version.signal_timeframe_minutes };
}

async function selectedModule2StrategyVersion() {
  const versionResult = await query(
    `SELECT sv.*
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
     WHERE sv.id = '00000000-0000-0000-0000-000000000402'
        OR s.id = '00000000-0000-0000-0000-000000000302'
     ORDER BY CASE WHEN sv.id = '00000000-0000-0000-0000-000000000402' THEN 0 ELSE 1 END, sv.activated_at DESC
     LIMIT 1`
  );
  return versionResult.rows[0] as any;
}

async function ensureTodayModule2Session(tenantId: string | null) {
  const version = await selectedModule2StrategyVersion();
  const sessionDate = newYorkDate();
  const existing = await query(
    `SELECT ts.*, sv.signal_timeframe_minutes
     FROM trading_sessions ts
     JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
     WHERE ts.symbol = 'XAUUSD'
       AND ts.strategy_version_id = $1
       AND ts.session_date = $2
       AND ts.session_preset = 'NY_SWEEP_BOS'
       AND ts.tenant_id = $3
       AND ts.module_code = 'high_probability_strategy_2'
     ORDER BY ts.created_at DESC
     LIMIT 1`,
    [version.id, sessionDate, tenantId]
  );
  if (existing.rows[0]) return existing.rows[0] as any;
  const times = sessionTimesForDate(sessionDate, version.session_start ?? "09:30", Number(version.opening_range_minutes ?? 0), version.trade_window_end ?? "16:00");
  const { rows } = await query(
    `INSERT INTO trading_sessions (
      tenant_id, user_id, symbol, strategy_version_id, module_code, session_date, session_preset, state,
      session_start_at, opening_range_end_at, signal_window_end_at
    ) VALUES (
      $6, (SELECT id FROM users WHERE tenant_id = $6 LIMIT 1), 'XAUUSD', $1, 'high_probability_strategy_2', $2, 'NY_SWEEP_BOS', 'WAITING_FOR_SETUP', $3, $4, $5
    ) RETURNING *`,
    [version.id, sessionDate, times.sessionStartAt, times.openingRangeEndAt, times.signalWindowEndAt, tenantId]
  );
  return { ...rows[0], signal_timeframe_minutes: version.signal_timeframe_minutes };
}

async function selectedModule3StrategyVersion() {
  const versionResult = await query(
    `SELECT sv.*
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
     WHERE sv.id = '00000000-0000-0000-0000-000000000403'
        OR s.id = '00000000-0000-0000-0000-000000000303'
     ORDER BY CASE WHEN sv.id = '00000000-0000-0000-0000-000000000403' THEN 0 ELSE 1 END, sv.activated_at DESC
     LIMIT 1`
  );
  return versionResult.rows[0] as any;
}

async function ensureTodayModule3Session(tenantId: string | null) {
  const version = await selectedModule3StrategyVersion();
  const sessionDate = newYorkDate();
  const existing = await query(
    `SELECT ts.*, sv.signal_timeframe_minutes
     FROM trading_sessions ts
     JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
     WHERE ts.symbol = 'XAUUSD'
       AND ts.strategy_version_id = $1
       AND ts.session_date = $2
       AND ts.session_preset = 'NY_VWAP_DRIVE'
       AND ts.tenant_id = $3
       AND ts.module_code = 'strategy_lab_3'
     ORDER BY ts.created_at DESC
     LIMIT 1`,
    [version.id, sessionDate, tenantId]
  );
  if (existing.rows[0]) return existing.rows[0] as any;
  const config = version.configuration_json ?? {};
  const times = sessionTimesForDate(sessionDate, config.newYorkStartTime ?? version.session_start ?? "09:30", 0, config.newYorkEndTime ?? version.trade_window_end ?? "16:00");
  const { rows } = await query(
    `INSERT INTO trading_sessions (
      tenant_id, user_id, symbol, strategy_version_id, module_code, session_date, session_preset, state,
      session_start_at, opening_range_end_at, signal_window_end_at
    ) VALUES (
      $5, (SELECT id FROM users WHERE tenant_id = $5 LIMIT 1), 'XAUUSD', $1, 'strategy_lab_3', $2, 'NY_VWAP_DRIVE', 'WAITING_FOR_SETUP', $3, $3, $4
    ) RETURNING *`,
    [version.id, sessionDate, times.sessionStartAt, times.signalWindowEndAt, tenantId]
  );
  return { ...rows[0], signal_timeframe_minutes: version.signal_timeframe_minutes };
}

function buildModule3Replay(replayCase: Module3ReplayCase, session: any) {
  const direction = replayCase === "SELL" ? "SHORT" : "LONG";
  const isShort = direction === "SHORT";
  const valid = replayCase === "BUY" || replayCase === "SELL";
  const entry = isShort ? 2349 : 2351;
  const stop = isShort ? 2352 : 2348;
  const target = isShort ? 2343 : 2357;
  const sessionStart = new Date(session.session_start_at).getTime();
  const at = (minutes: number) => new Date(sessionStart + minutes * 60_000).toISOString();
  const driveStart = candle(at(0), 2350, 2351, 2349.4, isShort ? 2349.7 : 2350.4);
  const driveEnd = replayCase === "WEAK_OPENING_DRIVE"
    ? candle(at(30), 2350.2, 2350.7, 2349.8, 2350.3)
    : isShort
      ? candle(at(30), 2350.1, 2350.5, 2346.6, 2347.2)
      : candle(at(30), 2350.1, 2353.6, 2349.8, 2353.1);
  const pullback = isShort ? candle(at(45), 2348.4, 2350.2, 2348, 2349.7) : candle(at(45), 2352.4, 2352.7, 2350.1, 2350.7);
  const confirm = isShort ? candle(at(50), 2349.6, 2350, 2348.7, 2349) : candle(at(50), 2350.5, 2351.4, 2350.1, 2351);
  const snapshotCandles = [driveStart, driveEnd, pullback, confirm];
  const flags = {
    state: valid ? "SIGNAL_ACTIVE" : replayCase,
    drive: { start: driveStart, end: driveEnd, high: Math.max(driveStart.high, driveEnd.high), low: Math.min(driveStart.low, driveEnd.low), open: driveStart.open, close: driveEnd.close },
    vwap: isShort ? 2350.05 : 2350.45,
    ema: isShort ? 2350.2 : 2350.35,
    entryZone: { low: isShort ? 2349.8 : 2350.1, high: isShort ? 2350.4 : 2350.8, midpoint: isShort ? 2350.1 : 2350.45, kind: "VWAP_PULLBACK_ZONE" },
    riskReward: replayCase === "INVALID_RR" ? 1.2 : 2,
    replay: true
  };
  const failure = replayCase === "WEAK_OPENING_DRIVE" ? "OPENING_DRIVE_STRONG"
    : replayCase === "NO_VWAP_ALIGNMENT" ? "VWAP_ALIGNMENT"
      : replayCase === "NO_PULLBACK" ? "PULLBACK_ZONE_TOUCHED"
        : replayCase === "NO_CONFIRMATION" ? "CONFIRMATION_CANDLE"
          : replayCase === "INVALID_RR" ? "QUALITY_RR"
            : replayCase === "NO_TRADE" ? "NY_SESSION_ACTIVE"
              : null;
  const evaluations = module3ReplayEvaluations(failure, replayCase);
  const status = valid ? (isShort ? "SHORT SETUP READY" : "LONG SETUP READY") : replayCase === "WEAK_OPENING_DRIVE" ? "NO TRADE" : replayCase === "NO_TRADE" ? "BLOCKED" : "WAIT";
  const scenario = valid
    ? isShort ? "NY_VWAP_OPENING_DRIVE_PULLBACK_SELL" : "NY_VWAP_OPENING_DRIVE_PULLBACK_BUY"
    : replayCase === "WEAK_OPENING_DRIVE" ? "NO_STRONG_OPENING_DRIVE"
      : replayCase === "NO_TRADE" ? "HARD_RULE_BLOCK"
        : "VWAP_PULLBACK_NOT_READY";
  return {
    scenario,
    expectedScenario: MODULE3_QA_CASES.find((item) => item.code === replayCase)?.expected ?? scenario,
    direction: valid ? direction : failure === "NY_SESSION_ACTIVE" ? null : direction,
    status,
    entryPrice: valid || replayCase === "INVALID_RR" ? entry : null,
    stopPrice: valid || replayCase === "INVALID_RR" ? stop : null,
    targetPrice: valid || replayCase === "INVALID_RR" ? target : null,
    finalReason: valid
      ? `Module 3 ${isShort ? "SELL" : "BUY"} replay passed opening drive, VWAP alignment, pullback, confirmation candle, and 2.00R plan.`
      : `Module 3 replay blocked by ${failure ?? "NO_TRADE"}.`,
    score: valid ? 92 : replayCase === "INVALID_RR" ? 76 : 45,
    grade: valid ? "A+" : "C",
    reasons: valid ? ["NY opening drive confirmed", "VWAP continuation aligned", "Pullback zone respected", "Risk-reward 2.00R"] : [`Replay failure: ${failure}`],
    flags,
    evaluations,
    snapshotCandles
  };
}

function module3ReplayEvaluations(failure: string | null, replayCase: Module3ReplayCase) {
  const defaults = [
    ["NY_SESSION_ACTIVE", "New York session active", true, true, "10:00", "09:30-16:00", "Module 3 only evaluates during its configured New York VWAP window."],
    ["DAILY_TRADE_LIMIT", "Daily trade limit not reached", true, true, 0, "< 1", "Only one automatic Module 3 paper trade is allowed per session by default."],
    ["OPENING_DRIVE_COMPLETE", "Opening drive complete", true, true, 30, "after 30 minutes", "The first NY impulse window must finish before pullback entries."],
    ["OPENING_DRIVE_STRONG", "Opening drive strength", true, true, "1.4 ATR", ">= 1 ATR", "The opening drive must meet ATR range and candle body requirements."],
    ["VWAP_ALIGNMENT", "VWAP alignment", true, true, "aligned", "aligned", "Price must remain on the correct side of VWAP after the opening drive."],
    ["EMA_ALIGNMENT", "20 EMA alignment", true, false, "aligned", "aligned", "EMA alignment supports continuation context."],
    ["PULLBACK_ZONE_READY", "VWAP/EMA pullback zone ready", true, true, "2349.80-2350.40", "valid VWAP/EMA zone", "A valid VWAP/EMA value zone must exist before pullback entry."],
    ["PULLBACK_ZONE_TOUCHED", "Pullback zone touched", true, true, "touched", "VWAP/EMA zone", "Price must pull back into the VWAP/EMA value zone."],
    ["CONFIRMATION_CANDLE", "Confirmation candle", true, true, "confirmed", "direction candle", "A completed candle must confirm continuation away from the pullback zone."],
    ["QUALITY_SPREAD", "Spread filter", true, true, 0.25, "<= 0.8", "Spread must be acceptable for XAUUSD paper entry."],
    ["QUALITY_NEWS", "No high-impact news", true, true, "CLEAR", "CLEAR", "News filter must be clear for automation."],
    ["QUALITY_RR", "Minimum RR 2:1", true, true, replayCase === "INVALID_RR" ? 1.2 : 2, ">= 2", "Reward-to-risk must meet the configured minimum."],
    ["QUALITY_STOP_SIZE", "Maximum stop size", true, true, "1.1 ATR", "<= 1.35 ATR", "Stop distance must remain inside the configured ATR limit."],
    ["SIGNAL_SCORE", "Minimum signal score", true, true, replayCase === "INVALID_RR" ? 76 : 92, ">= 80", "Module 3 requires a high-quality opening-drive pullback score."]
  ] as const;
  return defaults.map(([ruleCode, name, defaultPass, blocking, actualValue, requiredValue, explanation]) => {
    const passed = failure === ruleCode ? false : defaultPass;
    return { ruleCode, name, status: passed ? "PASS" : "FAIL", blocking, source: "QA_REPLAY", actualValue, requiredValue, explanation };
  });
}

function buildReplay(replayCase: ReplayCase, session: any) {
  const openingRangeCandles = [replayCandle(session.session_start_at, 100, 110, 90, 104)];
  const t0 = new Date(session.opening_range_end_at).getTime();
  const at = (minutesAfterOrb: number) => new Date(t0 + minutesAfterOrb * 60_000).toISOString();
  const trendUp = Array.from({ length: 50 }, (_, index) => replayCandle(new Date(t0 - (50 - index) * 15 * 60_000).toISOString(), 96 + index * 0.2, 98 + index * 0.2, 95 + index * 0.2, 97 + index * 0.2));
  const trendDown = Array.from({ length: 50 }, (_, index) => replayCandle(new Date(t0 - (50 - index) * 15 * 60_000).toISOString(), 114 - index * 0.2, 115 - index * 0.2, 112 - index * 0.2, 113 - index * 0.2));

  if (replayCase === "SELL") {
    return {
      openingRangeCandles,
      previousCandles: trendDown,
      currentCandle: replayCandle(at(15), 93, 94, 86, 87),
      expectedScenario: "OPENING_DRIVE_CLEAN_BREAKOUT"
    };
  }
  if (replayCase === "RETEST") {
    return {
      openingRangeCandles,
      previousCandles: [...trendUp, replayCandle(at(15), 107, 114, 106, 113)],
      currentCandle: replayCandle(at(30), 111, 113, 110.5, 112.8),
      expectedScenario: "BREAKOUT_RETEST_CONFIRMED"
    };
  }
  if (replayCase === "FAKEOUT") {
    return {
      openingRangeCandles,
      previousCandles: [],
      currentCandle: replayCandle(at(15), 108, 112, 100, 105),
      expectedScenario: "FAKEOUT_REVERSAL_CANDIDATE"
    };
  }
  if (replayCase === "SWEEP_REVERSAL") {
    return {
      openingRangeCandles,
      previousCandles: [...trendDown, replayCandle(at(15), 108, 112, 100, 104)],
      currentCandle: replayCandle(at(30), 94, 95, 86, 87),
      expectedScenario: "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED"
    };
  }
  if (replayCase === "OVEREXTENDED") {
    return {
      openingRangeCandles,
      previousCandles: trendUp,
      currentCandle: replayCandle(at(15), 111, 125, 110, 124),
      expectedScenario: "OVEREXTENDED_BREAKOUT_NO_TRADE"
    };
  }
  if (replayCase === "NO_TRADE") {
    return {
      openingRangeCandles,
      previousCandles: [replayCandle(at(15), 100, 112, 99, 105)],
      currentCandle: replayCandle(at(30), 105, 106, 88, 95),
      expectedScenario: "DOUBLE_SIDED_SWEEP"
    };
  }
  return {
    openingRangeCandles,
    previousCandles: trendUp,
    currentCandle: replayCandle(at(15), 107, 114, 106, 113),
    expectedScenario: "OPENING_DRIVE_CLEAN_BREAKOUT"
  };
}

function replayCandle(timestampUtc: string, open: number, high: number, low: number, close: number): Candle {
  const priceOffset = 3950;
  return candle(timestampUtc, open + priceOffset, high + priceOffset, low + priceOffset, close + priceOffset);
}

function candle(timestampUtc: string, open: number, high: number, low: number, close: number): Candle {
  return { timestampUtc, open, high, low, close, spread: 0.2 };
}

function buildModule2Replay(replayCase: Module2ReplayCase, session: any) {
  const base = new Date(session.session_start_at).getTime();
  const at = (minutesAfterStart: number) => new Date(base + minutesAfterStart * 60_000).toISOString();
  const direction = replayCase === "SELL" ? "SHORT" : "LONG";
  const isShort = direction === "SHORT";
  const liquidityPrice = isShort ? 4068.2 : 4048.4;
  const sweepPrice = isShort ? 4070.1 : 4046.7;
  const bosLevel = isShort ? 4058.4 : 4058.9;
  const zoneLow = isShort ? 4060.55 : 4054.15;
  const zoneHigh = isShort ? 4062.25 : 4055.9;
  const entry = (zoneLow + zoneHigh) / 2;
  const stop = isShort ? 4069.4 : 4045.9;
  const target = isShort ? 4044.8 : 4074.7;
  const failureStateByCase: Record<Module2ReplayCase, string> = {
    BUY: "SIGNAL_ACTIVE",
    SELL: "SIGNAL_ACTIVE",
    SWEEP_NO_DISPLACEMENT: "WAITING_FOR_DISPLACEMENT",
    DISPLACEMENT_NO_BOS: "WAITING_FOR_BOS",
    BOS_NO_RETRACE: "WAITING_FOR_RETRACE",
    INVALIDATED_SETUP: "SETUP_INVALIDATED",
    LOW_SCORE_NO_TRADE: "LOW_SCORE_NO_TRADE"
  };
  const state = failureStateByCase[replayCase];
  const signal = state === "SIGNAL_ACTIVE";
  const scenario = signal
    ? (isShort ? "NY_LIQUIDITY_SWEEP_BOS_SELL" : "NY_LIQUIDITY_SWEEP_BOS_BUY")
    : state;
  const status = signal
    ? (isShort ? "SHORT SETUP READY" : "LONG SETUP READY")
    : state === "SETUP_INVALIDATED" || state === "LOW_SCORE_NO_TRADE"
      ? "NO TRADE"
      : "WAIT";
  const score = replayCase === "LOW_SCORE_NO_TRADE" ? 62 : signal ? 91 : 74;
  const grade = score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : "C";
  const evaluations = module2ReplayEvaluations(replayCase, direction);
  const flags = {
    state,
    htfBias: isShort ? "BEARISH" : "BULLISH",
    levels: [
      { type: isShort ? "LONDON_HIGH" : "LONDON_LOW", side: isShort ? "BUY_SIDE" : "SELL_SIDE", price: liquidityPrice, priority: "HIGH", source: "Replay NY liquidity map" },
      { type: isShort ? "ASIAN_LOW" : "ASIAN_HIGH", side: isShort ? "SELL_SIDE" : "BUY_SIDE", price: isShort ? 4048.6 : 4067.8, priority: "MEDIUM", source: "Replay target liquidity" }
    ],
    sweep: {
      level: { type: isShort ? "LONDON_HIGH" : "LONDON_LOW", side: isShort ? "BUY_SIDE" : "SELL_SIDE", price: liquidityPrice, priority: "HIGH", source: "Replay" },
      swept: true,
      sweptAt: at(20),
      closedBackAt: at(25),
      distanceAtr: 0.32,
      candle: replayCandle(at(20), isShort ? 4064 : 4052, isShort ? sweepPrice : 4054, isShort ? 4061 : sweepPrice, isShort ? 4066 : 4050.5),
      closeBackCandle: replayCandle(at(25), isShort ? 4068 : 4047, isShort ? 4069 : 4051, isShort ? 4063 : 4046.9, isShort ? 4067 : 4049.2)
    },
    displacement: replayCase === "SWEEP_NO_DISPLACEMENT" ? null : {
      candle: replayCandle(at(30), isShort ? 4066.8 : 4049.2, isShort ? 4067.1 : 4058.6, isShort ? 4058.1 : 4048.9, isShort ? 4058.8 : 4058.1),
      rangeAtr: 1.55,
      bodyRatio: 0.73,
      closeLocation: isShort ? 0.12 : 0.89
    },
    bos: ["SWEEP_NO_DISPLACEMENT", "DISPLACEMENT_NO_BOS"].includes(replayCase) ? null : {
      level: bosLevel,
      candle: replayCandle(at(35), isShort ? 4058.7 : 4058.2, isShort ? 4060.1 : 4061.8, isShort ? 4054.2 : 4057.8, isShort ? 4055.1 : 4061.3),
      structure: { kind: isShort ? "LOW" : "HIGH", price: bosLevel, time: at(5) }
    },
    entryZone: ["SWEEP_NO_DISPLACEMENT", "DISPLACEMENT_NO_BOS"].includes(replayCase) ? null : {
      kind: replayCase === "SELL" ? "ORDER_BLOCK" : "FVG",
      low: zoneLow,
      high: zoneHigh,
      midpoint: entry,
      createdAt: at(30)
    },
    riskReward: Math.abs(target - entry) / Math.abs(entry - stop),
    invalidation: replayCase === "INVALIDATED_SETUP" ? { time: at(50), reason: "Price closed through the stop side of the entry zone before confirmation." } : null
  };
  return {
    scenario,
    expectedScenario: signal ? scenario : state,
    direction: signal ? direction : ["BOS_NO_RETRACE", "DISPLACEMENT_NO_BOS", "SWEEP_NO_DISPLACEMENT", "INVALIDATED_SETUP", "LOW_SCORE_NO_TRADE"].includes(replayCase) ? direction : null,
    status,
    entryPrice: signal ? entry : null,
    stopPrice: signal ? stop : null,
    targetPrice: signal ? target : null,
    finalReason: module2ReplayReason(replayCase),
    evaluations,
    flags,
    score,
    grade,
    reasons: module2ReplayReasons(replayCase, score),
    snapshotCandles: [
      replayCandle(at(15), 4053.7, 4055.1, 4051.8, 4052.4),
      replayCandle(at(20), isShort ? 4064 : 4052, isShort ? sweepPrice : 4054, isShort ? 4061 : sweepPrice, isShort ? 4066 : 4050.5),
      replayCandle(at(25), isShort ? 4068 : 4047, isShort ? 4069 : 4051, isShort ? 4063 : 4046.9, isShort ? 4067 : 4049.2),
      replayCandle(at(30), isShort ? 4066.8 : 4049.2, isShort ? 4067.1 : 4058.6, isShort ? 4058.1 : 4048.9, isShort ? 4058.8 : 4058.1),
      replayCandle(at(35), isShort ? 4058.7 : 4058.2, isShort ? 4060.1 : 4061.8, isShort ? 4054.2 : 4057.8, isShort ? 4055.1 : 4061.3),
      replayCandle(at(45), isShort ? 4056.2 : 4060.9, isShort ? 4062.1 : 4061.2, isShort ? 4055.5 : 4054.8, isShort ? 4060.4 : 4055.4)
    ]
  };
}

function module2ReplayEvaluations(replayCase: Module2ReplayCase, direction: "LONG" | "SHORT") {
  const passUntil: Record<Module2ReplayCase, string[]> = {
    BUY: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE", "CONFIRM_EMA_200", "CONFIRM_VWAP", "CONFIRM_FRESH_FVG", "CONFIRM_ENTRY_CANDLE", "CONFIRMATION_COUNT", "QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FRESH_SETUP", "QUALITY_FILTER_COUNT", "SIGNAL_SCORE"],
    SELL: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE", "CONFIRM_EMA_200", "CONFIRM_VWAP", "CONFIRM_ORDER_BLOCK_RETEST", "CONFIRM_ENTRY_CANDLE", "CONFIRMATION_COUNT", "QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FRESH_SETUP", "QUALITY_FILTER_COUNT", "SIGNAL_SCORE"],
    SWEEP_NO_DISPLACEMENT: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED"],
    DISPLACEMENT_NO_BOS: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED"],
    BOS_NO_RETRACE: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "CONFIRM_FRESH_FVG"],
    INVALIDATED_SETUP: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "CONFIRM_FRESH_FVG"],
    LOW_SCORE_NO_TRADE: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE", "CONFIRM_FRESH_FVG", "CONFIRM_ENTRY_CANDLE", "QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS"]
  };
  const labels = [
    ["NY_SESSION_ACTIVE", "New York session active", "Current candle is inside the configured New York sweep window."],
    ["DAILY_TRADE_LIMIT", "Daily trade limit not reached", "Session trade limit allows a paper trade."],
    ["LIQUIDITY_LEVEL_IDENTIFIED", "Meaningful liquidity level identified", "A valid PDH/PDL, Asian, London, or equal high/low level was selected."],
    ["LIQUIDITY_SWEEP_CONFIRMED", "Liquidity sweep confirmed", "Price swept mapped liquidity and closed back through the level."],
    ["DISPLACEMENT_CONFIRMED", `${direction === "LONG" ? "Bullish" : "Bearish"} displacement confirmed`, "A strong directional displacement candle formed after the sweep."],
    ["BOS_CHOCH_CONFIRMED", "BOS or CHoCH confirmed by close", "Candle body closed beyond the selected internal structure point."],
    ["ENTRY_ZONE_READY", "Fresh entry zone ready", "A fresh FVG/order-block entry zone exists after BOS/CHoCH."],
    ["ENTRY_ZONE_RETRACE", "Price retraced into entry zone", "Price returned into the fresh entry zone before the confirmation candle."],
    ["CONFIRM_EMA_200", "Confirmation: 200 EMA alignment", "200 EMA confirmation matched."],
    ["CONFIRM_VWAP", "Confirmation: VWAP alignment", "VWAP confirmation matched."],
    ["CONFIRM_FRESH_FVG", "Confirmation: fresh FVG", "Fresh FVG confirmation matched."],
    ["CONFIRM_ORDER_BLOCK_RETEST", "Confirmation: order-block retest", "Order-block retest confirmation matched."],
    ["CONFIRM_ENTRY_CANDLE", "Confirmation: entry candle", "Entry candle confirmation matched."],
    ["CONFIRMATION_COUNT", "Confirmation layer passed", "At least 3 of 5 confirmations matched."],
    ["QUALITY_ATR_VOLATILITY", "Quality: ATR volatility", "ATR quality filter passed."],
    ["QUALITY_SPREAD", "Quality: spread", "Spread quality filter passed."],
    ["QUALITY_NEWS", "Quality: no high-impact news", "News quality filter passed."],
    ["QUALITY_RR", "Quality: RR >= 2:1", "Risk-reward quality filter passed."],
    ["QUALITY_STOP_SIZE", "Quality: stop size", "Stop-size quality filter passed."],
    ["QUALITY_FRESH_SETUP", "Quality: fresh setup", "Fresh setup quality filter passed."],
    ["QUALITY_FILTER_COUNT", "Quality layer passed", "At least 3 quality filters matched."],
    ["SIGNAL_SCORE", "Minimum signal score", "Final Module 2 signal score reached the configured threshold."]
  ];
  const passed = new Set(passUntil[replayCase]);
  return labels.map(([ruleCode, name, explanation]) => ({
    ruleCode,
    name,
    status: passed.has(ruleCode) ? "PASS" : replayCase === "LOW_SCORE_NO_TRADE" && ["CONFIRMATION_COUNT", "QUALITY_FILTER_COUNT", "SIGNAL_SCORE"].includes(ruleCode) ? "FAIL" : "WAIT",
    blocking: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE", "CONFIRM_ENTRY_CANDLE", "CONFIRMATION_COUNT", "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FILTER_COUNT", "SIGNAL_SCORE"].includes(ruleCode),
    source: "MODULE2_REPLAY",
    actualValue: passed.has(ruleCode) ? "matched" : "not matched",
    requiredValue: "matched",
    explanation: passed.has(ruleCode) ? explanation : module2ReplayReason(replayCase)
  }));
}

function module2ReplayReason(replayCase: Module2ReplayCase) {
  const reasons: Record<Module2ReplayCase, string> = {
    BUY: "BUY signal validated through hard rules, at least 3 confirmations, and at least 3 quality filters.",
    SELL: "SELL signal validated through hard rules, at least 3 confirmations, and at least 3 quality filters.",
    SWEEP_NO_DISPLACEMENT: "Liquidity was swept, but the required displacement candle did not appear.",
    DISPLACEMENT_NO_BOS: "Sweep and displacement appeared, but structure was not broken by candle close.",
    BOS_NO_RETRACE: "BOS confirmed and the zone exists, but price has not retraced into the entry zone.",
    INVALIDATED_SETUP: "The setup was invalidated before entry confirmation.",
    LOW_SCORE_NO_TRADE: "The hard-rule sequence formed, but confirmation/quality layer counts are below the trading threshold."
  };
  return reasons[replayCase];
}

function module2ReplayReasons(replayCase: Module2ReplayCase, score: number) {
  return [
    replayCase.includes("SELL") ? "Buy-side liquidity swept" : "Sell-side liquidity swept",
    "Module 2 replay evidence snapshot",
    replayCase === "LOW_SCORE_NO_TRADE" ? "Score below production threshold" : `Score ${score}/110`,
    "No Twelve Data credit used"
  ];
}

function module2ReplayQaSummary(replay: ReturnType<typeof buildModule2Replay>, testCase: (typeof MODULE2_QA_CASES)[number]) {
  const evaluations = replay.evaluations;
  const statusByRule = new Map(evaluations.map((row) => [row.ruleCode, row.status]));
  const hardRuleCodes = ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE"];
  const hardRulesPassed = hardRuleCodes.every((code) => statusByRule.get(code) === "PASS");
  const entryTriggerPassed = statusByRule.get("CONFIRM_ENTRY_CANDLE") === "PASS";
  const confirmationCount = ["CONFIRM_EMA_200", "CONFIRM_VWAP", "CONFIRM_FRESH_FVG", "CONFIRM_ORDER_BLOCK_RETEST", "CONFIRM_ENTRY_CANDLE"]
    .filter((code) => statusByRule.get(code) === "PASS").length;
  const qualityCount = ["QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FRESH_SETUP"]
    .filter((code) => statusByRule.get(code) === "PASS").length;
  const safetyRulesPassed = ["QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "SIGNAL_SCORE"].every((code) => statusByRule.get(code) === "PASS");
  const paperEligible = replay.status.includes("SETUP READY") && replay.entryPrice != null && replay.stopPrice != null && replay.targetPrice != null;
  const scenarioMatched = replay.scenario === testCase.expected || replay.flags.state === testCase.expected;
  const statusMatched = replay.status === testCase.expectedStatus;
  const paperMatched = paperEligible === testCase.opensPaperTrade;
  const failureRuleMatched = testCase.failureRule ? statusByRule.get(testCase.failureRule) !== "PASS" : true;
  const validSignalLayersMatched = testCase.opensPaperTrade ? hardRulesPassed && entryTriggerPassed && confirmationCount >= 3 && qualityCount >= 3 && safetyRulesPassed : true;
  const passed = scenarioMatched && statusMatched && paperMatched && failureRuleMatched && validSignalLayersMatched;
  const blockingFailure = evaluations.find((row) => row.blocking && row.status !== "PASS")?.ruleCode ?? null;
  const reasons = [
    scenarioMatched ? null : `Expected ${testCase.expected}, got ${replay.scenario}/${replay.flags.state}.`,
    statusMatched ? null : `Expected status ${testCase.expectedStatus}, got ${replay.status}.`,
    paperMatched ? null : `Paper eligibility expected ${testCase.opensPaperTrade}, got ${paperEligible}.`,
    failureRuleMatched ? null : `Expected ${testCase.failureRule} to block or wait.`,
    validSignalLayersMatched ? null : `Valid signal needs hard rules, entry confirmation, 3 confirmations, 3 quality filters, safety filters, and signal score.`
  ].filter(Boolean);
  return {
    passed,
    hardRulesPassed,
    entryTriggerPassed,
    confirmationCount,
    qualityCount,
    safetyRulesPassed,
    paperEligible,
    blockingFailure,
    reason: passed ? "Replay behavior matches Module 2 QA expectation." : reasons.join(" ")
  };
}

async function openModule2ReplayPaperTrade(setup: any, tenantId: string | null) {
  if (setup.module_code !== "high_probability_strategy_2") return null;
  if (setup.entry_price == null || setup.stop_price == null || setup.target_price == null) return null;
  const rewardToRisk = Math.abs(Number(setup.target_price) - Number(setup.entry_price)) / Math.max(0.00001, Math.abs(Number(setup.entry_price) - Number(setup.stop_price)));
  const plan = await query(
    `INSERT INTO trade_plans (
      setup_candidate_id, planned_entry, planned_stop, planned_target,
      planned_lot, planned_risk_amount, reward_to_risk, status
    ) VALUES ($1,$2,$3,$4,0.01,10,$5,'EXECUTED')
    ON CONFLICT (setup_candidate_id) DO UPDATE SET
      planned_entry = EXCLUDED.planned_entry,
      planned_stop = EXCLUDED.planned_stop,
      planned_target = EXCLUDED.planned_target,
      planned_lot = EXCLUDED.planned_lot,
      planned_risk_amount = EXCLUDED.planned_risk_amount,
      reward_to_risk = EXCLUDED.reward_to_risk,
      status = 'EXECUTED'
    RETURNING *`,
    [setup.id, setup.entry_price, setup.stop_price, setup.target_price, rewardToRisk]
  );
  const existing = await query("SELECT * FROM trades WHERE trade_plan_id = $1 ORDER BY opened_at DESC LIMIT 1", [plan.rows[0].id]);
  if (existing.rows[0]) return existing.rows[0];
  const trade = await query(
    `INSERT INTO trades (
      trade_plan_id, actual_entry, actual_stop, actual_target, actual_lot,
      commission, spread, slippage, opened_at, outcome
    ) VALUES ($1,$2,$3,$4,0.01,0,0.2,0,now(),'ACTIVE') RETURNING *`,
    [plan.rows[0].id, setup.entry_price, setup.stop_price, setup.target_price]
  );
  await query("UPDATE setup_candidates SET status = 'PAPER_TRADE_OPENED' WHERE id = $1 AND tenant_id = $2", [setup.id, tenantId]);
  await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,'MODULE2_QA_ENTRY_HIT',$2)", [trade.rows[0].id, { setupId: setup.id, replay: true }]);
  await query(
    `INSERT INTO journal_entries (
      tenant_id, setup_candidate_id, trade_id, session_id, decision, confidence, lesson, process_grade, outcome
    ) VALUES ($1,$2,$3,$4,'MODULE2_QA_PAPER_TRADE_OPENED',90,$5,'QA','ACTIVE')`,
    [
      tenantId,
      setup.id,
      trade.rows[0].id,
      setup.session_id,
      "Module 2 replay opened a QA paper trade after the valid checklist chain matched."
    ]
  );
  return trade.rows[0];
}

async function openModuleReplayPaperTrade(setup: any, tenantId: string | null, eventPrefix: string) {
  if (setup.entry_price == null || setup.stop_price == null || setup.target_price == null) return null;
  const rewardToRisk = Math.abs(Number(setup.target_price) - Number(setup.entry_price)) / Math.max(0.00001, Math.abs(Number(setup.entry_price) - Number(setup.stop_price)));
  const plan = await query(
    `INSERT INTO trade_plans (
      setup_candidate_id, planned_entry, planned_stop, planned_target,
      planned_lot, planned_risk_amount, reward_to_risk, status
    ) VALUES ($1,$2,$3,$4,0.01,10,$5,'EXECUTED')
    ON CONFLICT (setup_candidate_id) DO UPDATE SET
      planned_entry = EXCLUDED.planned_entry,
      planned_stop = EXCLUDED.planned_stop,
      planned_target = EXCLUDED.planned_target,
      planned_lot = EXCLUDED.planned_lot,
      planned_risk_amount = EXCLUDED.planned_risk_amount,
      reward_to_risk = EXCLUDED.reward_to_risk,
      status = 'EXECUTED'
    RETURNING *`,
    [setup.id, setup.entry_price, setup.stop_price, setup.target_price, rewardToRisk]
  );
  const existing = await query("SELECT * FROM trades WHERE trade_plan_id = $1 ORDER BY opened_at DESC LIMIT 1", [plan.rows[0].id]);
  if (existing.rows[0]) return existing.rows[0];
  const trade = await query(
    `INSERT INTO trades (
      trade_plan_id, actual_entry, actual_stop, actual_target, actual_lot,
      commission, spread, slippage, opened_at, outcome
    ) VALUES ($1,$2,$3,$4,0.01,0,0.2,0,now(),'ACTIVE') RETURNING *`,
    [plan.rows[0].id, setup.entry_price, setup.stop_price, setup.target_price]
  );
  await query("UPDATE setup_candidates SET status = 'PAPER_TRADE_OPENED' WHERE id = $1 AND tenant_id = $2", [setup.id, tenantId]);
  await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,$2,$3)", [trade.rows[0].id, `${eventPrefix}_ENTRY_HIT`, { setupId: setup.id, replay: true, moduleCode: setup.module_code }]);
  await query(
    `INSERT INTO journal_entries (
      tenant_id, setup_candidate_id, trade_id, session_id, decision, confidence, lesson, process_grade, outcome
    ) VALUES ($1,$2,$3,$4,$5,90,$6,'QA','ACTIVE')`,
    [
      tenantId,
      setup.id,
      trade.rows[0].id,
      setup.session_id,
      `${eventPrefix}_PAPER_TRADE_OPENED`,
      `${setup.module_code} replay opened a QA paper trade after the valid checklist matched.`
    ]
  );
  return trade.rows[0];
}
