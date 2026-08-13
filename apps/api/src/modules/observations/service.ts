import { query } from "../../infrastructure/db/client.js";
import { recordOperationalEvent } from "../../infrastructure/observability/operational-events.js";

const MODULE_CODES = ["orb_max_options", "high_probability_strategy_2"];
const SIGNAL_STATUSES = ["LONG SETUP READY", "SHORT SETUP READY", "TRADE_PLANNED", "PAPER_TRADE_OPENED"];
const ARTIFACT_GRACE_MINUTES = 15;
const configuredBatchSize = Number(process.env.PRODUCTION_OBSERVATION_BATCH_SIZE ?? 100);
const OBSERVATION_BATCH_SIZE = Number.isFinite(configuredBatchSize)
  ? Math.min(500, Math.max(25, Math.floor(configuredBatchSize)))
  : 100;

export async function refreshProductionSignalObservations(input: { tenantId?: string; moduleCode?: string; days?: number } = {}) {
  const days = Math.min(30, Math.max(1, Number(input.days ?? 7)));
  const cutoverResult = await query(
    "SELECT applied_at FROM schema_migrations WHERE filename = '084_production_signal_observation.sql' LIMIT 1"
  );
  const observerCutoverAt = cutoverResult.rows[0]?.applied_at ?? new Date().toISOString();
  const params: unknown[] = [days, MODULE_CODES, SIGNAL_STATUSES, OBSERVATION_BATCH_SIZE];
  const tenantFilter = input.tenantId ? `AND sc.tenant_id = $${params.push(input.tenantId)}` : "";
  const moduleFilter = input.moduleCode ? `AND sc.module_code = $${params.push(input.moduleCode)}` : "";
  const candidates = await query(
    `WITH selected_candidates AS MATERIALIZED (
       SELECT sc.*, ts.session_date, ts.session_preset,
              existing.observation_status AS prior_observation_status
       FROM setup_candidates sc
       JOIN trading_sessions ts ON ts.id = sc.session_id
       LEFT JOIN production_signal_observations existing ON existing.setup_candidate_id = sc.id
       WHERE sc.module_code = ANY($2::text[])
         AND sc.detected_at >= now() - ($1::text || ' days')::interval
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'
         AND (sc.direction IN ('LONG','SHORT') OR sc.status = ANY($3::text[]))
         AND (
           existing.id IS NULL
           OR sc.detected_at >= now() - interval '18 hours'
           OR (
             existing.signal_expected = true
             AND (
               existing.observation_status <> 'PASS'
               OR EXISTS (
                 SELECT 1 FROM trade_plans open_plan
                 JOIN trades open_trade ON open_trade.trade_plan_id = open_plan.id
                 WHERE open_plan.setup_candidate_id = sc.id AND open_trade.closed_at IS NULL
               )
             )
           )
         )
         ${tenantFilter} ${moduleFilter}
       ORDER BY (existing.id IS NULL) DESC, sc.detected_at DESC
       LIMIT $4
     )
     SELECT sc.*,
            tp.id AS trade_plan_id,
            t.id AS trade_id, t.outcome AS trade_outcome, t.opened_at, t.closed_at,
            COALESCE(targets.target_count, 0)::int AS target_count,
            COALESCE(targets.terminal_targets, 0)::int AS terminal_targets,
            terminal.event_type AS terminal_event_type,
            signal.id AS signal_notification_id,
            brain.metadata AS brain_metadata,
            journal.id AS journal_id,
            COALESCE(blockers.rows, '[]'::jsonb) AS blockers
     FROM selected_candidates sc
     LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
     LEFT JOIN trades t ON t.trade_plan_id = tp.id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS target_count,
              count(*) FILTER (WHERE status = 'HIT' AND target_number = 3)::int AS terminal_targets
       FROM paper_trade_targets WHERE trade_id = t.id
     ) targets ON true
     LEFT JOIN LATERAL (
       SELECT te.event_type
       FROM trade_events te
       WHERE te.trade_id = t.id
         AND te.event_type IN ('PAPER_TP3_HIT', 'PAPER_SL_HIT', 'PAPER_EXIT')
       ORDER BY te.created_at DESC LIMIT 1
     ) terminal ON true
     LEFT JOIN LATERAL (
       SELECT n.id FROM notifications n
       WHERE n.tenant_id = sc.tenant_id
         AND n.event_type IN ('SETUP_READY','MODULE2_SETUP_READY')
         AND n.data->>'setupCandidateId' = sc.id::text
       ORDER BY n.created_at DESC LIMIT 1
     ) signal ON true
     LEFT JOIN LATERAL (
       SELECT oe.metadata FROM operational_events oe
       WHERE oe.tenant_id = sc.tenant_id AND oe.event_type = 'MAIN_BRAIN_DECISION'
         AND oe.metadata->>'setupId' = sc.id::text
       ORDER BY oe.created_at DESC LIMIT 1
     ) brain ON true
     LEFT JOIN LATERAL (
       SELECT je.id FROM journal_entries je
       WHERE je.tenant_id = sc.tenant_id AND je.setup_candidate_id = sc.id
       ORDER BY je.created_at DESC LIMIT 1
     ) journal ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'ruleCode', sre.rule_code, 'status', sre.status, 'blocking', sre.blocking,
         'explanation', sre.explanation
       ) ORDER BY sre.evaluated_at) AS rows
       FROM setup_rule_evaluations sre
       WHERE sre.setup_candidate_id = sc.id
         AND sre.status NOT IN ('PASS', 'NOT_APPLICABLE')
     ) blockers ON true
     ORDER BY sc.detected_at DESC
    `,
    params
  );

  let changedFailures = 0;
  for (const row of candidates.rows as any[]) {
    const observation = deriveObservation(row, observerCutoverAt);
    await query(
      `INSERT INTO production_signal_observations (
         tenant_id, module_code, session_id, setup_candidate_id, setup_detected_at,
         observation_status, signal_expected, prediction_observed, signal_observed,
         paper_tracking_expected, trade_plan_observed, paper_trade_observed,
         target_ladder_observed, journal_observed, terminal_lifecycle_observed,
         missing_steps, blocker_evidence, evidence, resolved_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19)
       ON CONFLICT (setup_candidate_id) DO UPDATE SET
         observation_status = EXCLUDED.observation_status,
         signal_expected = EXCLUDED.signal_expected,
         prediction_observed = EXCLUDED.prediction_observed,
         signal_observed = EXCLUDED.signal_observed,
         paper_tracking_expected = EXCLUDED.paper_tracking_expected,
         trade_plan_observed = EXCLUDED.trade_plan_observed,
         paper_trade_observed = EXCLUDED.paper_trade_observed,
         target_ladder_observed = EXCLUDED.target_ladder_observed,
         journal_observed = EXCLUDED.journal_observed,
         terminal_lifecycle_observed = EXCLUDED.terminal_lifecycle_observed,
         missing_steps = EXCLUDED.missing_steps,
         blocker_evidence = EXCLUDED.blocker_evidence,
         evidence = EXCLUDED.evidence,
         last_observed_at = now(),
         resolved_at = EXCLUDED.resolved_at`,
      [
        row.tenant_id, row.module_code, row.session_id, row.id, row.detected_at,
        observation.status, observation.signalExpected, observation.predictionObserved, observation.signalObserved,
        observation.paperExpected, observation.planObserved, observation.tradeObserved,
        observation.targetsObserved, observation.journalObserved, observation.terminalObserved,
        JSON.stringify(observation.missing), JSON.stringify(row.blockers ?? []), JSON.stringify(observation.evidence),
        observation.status === "PASS" ? new Date().toISOString() : null
      ]
    );
    if (observation.status === "FAIL" && row.prior_observation_status !== "FAIL") {
      changedFailures += 1;
      await recordOperationalEvent({
        severity: "ERROR",
        category: "WORKER",
        eventType: "MVP_SIGNAL_LIFECYCLE_FAILED",
        source: "production-signal-observer",
        tenantId: row.tenant_id,
        message: `${row.module_code} setup ${row.id} is missing required lifecycle evidence: ${observation.missing.join(", ")}.`,
        metadata: { moduleCode: row.module_code, setupId: row.id, missingSteps: observation.missing }
      });
    }
  }
  return {
    observed: candidates.rows.length,
    batchSize: OBSERVATION_BATCH_SIZE,
    batchFull: candidates.rows.length === OBSERVATION_BATCH_SIZE,
    changedFailures,
    generatedAt: new Date().toISOString()
  };
}

export async function buildProductionObservationReport(input: { tenantId?: string; moduleCode?: string; days?: number } = {}) {
  const days = Math.min(30, Math.max(1, Number(input.days ?? 7)));
  const params: unknown[] = [days];
  const tenantFilter = input.tenantId ? `AND observation.tenant_id = $${params.push(input.tenantId)}` : "";
  const moduleFilter = input.moduleCode ? `AND observation.module_code = $${params.push(input.moduleCode)}` : "";
  const [summary, modules, recent, blockers, sessions] = await Promise.all([
    query(
      `SELECT count(*)::int AS observed,
              count(*) FILTER (WHERE observation_status = 'PASS')::int AS passed,
              count(*) FILTER (WHERE observation_status = 'WARN')::int AS warnings,
              count(*) FILTER (WHERE observation_status = 'FAIL')::int AS failures,
              count(*) FILTER (WHERE observation_status = 'OBSERVING')::int AS observing,
              count(*) FILTER (WHERE signal_expected)::int AS expected_signals,
              count(*) FILTER (WHERE signal_observed)::int AS observed_signals,
              count(*) FILTER (WHERE paper_trade_observed)::int AS paper_trades,
              max(last_observed_at) AS last_observed_at
       FROM production_signal_observations observation
       WHERE setup_detected_at >= now() - ($1::text || ' days')::interval ${tenantFilter} ${moduleFilter}`,
      params
    ),
    query(
      `SELECT observation.module_code, module.name AS module_name,
              count(*)::int AS observed,
              count(*) FILTER (WHERE observation.signal_expected)::int AS expected_signals,
              count(*) FILTER (WHERE observation.signal_observed)::int AS observed_signals,
              count(*) FILTER (WHERE observation.paper_trade_observed)::int AS paper_trades,
              count(*) FILTER (WHERE observation.observation_status = 'FAIL')::int AS failures,
              count(*) FILTER (WHERE observation.observation_status = 'WARN')::int AS warnings
       FROM production_signal_observations observation
       JOIN platform_strategy_modules module ON module.code = observation.module_code
       WHERE observation.setup_detected_at >= now() - ($1::text || ' days')::interval ${tenantFilter} ${moduleFilter}
       GROUP BY observation.module_code, module.name ORDER BY module.name`, params),
    query(
      `SELECT observation.*, setup.scenario, setup.direction, setup.status AS setup_status,
              setup.entry_price, setup.stop_price, setup.target_price
       FROM production_signal_observations observation
       JOIN setup_candidates setup ON setup.id = observation.setup_candidate_id
       WHERE observation.setup_detected_at >= now() - ($1::text || ' days')::interval ${tenantFilter} ${moduleFilter}
       ORDER BY observation.setup_detected_at DESC LIMIT 30`, params),
    query(
      `SELECT blocker->>'ruleCode' AS rule_code, count(*)::int AS count
       FROM production_signal_observations observation
       CROSS JOIN LATERAL jsonb_array_elements(observation.blocker_evidence) blocker
       WHERE observation.setup_detected_at >= now() - ($1::text || ' days')::interval ${tenantFilter} ${moduleFilter}
       GROUP BY blocker->>'ruleCode' ORDER BY count DESC LIMIT 10`, params),
    query(
      `SELECT session.session_date, observation.module_code,
              count(*) FILTER (WHERE observation.signal_expected)::int AS expected_signals,
              count(*) FILTER (WHERE observation.signal_observed)::int AS observed_signals,
              count(*) FILTER (WHERE observation.paper_trade_observed)::int AS paper_trades,
              count(*) FILTER (WHERE observation.observation_status = 'FAIL')::int AS failures
       FROM production_signal_observations observation
       JOIN trading_sessions session ON session.id = observation.session_id
       WHERE observation.setup_detected_at >= now() - ($1::text || ' days')::interval ${tenantFilter} ${moduleFilter}
       GROUP BY session.session_date, observation.module_code
       ORDER BY session.session_date DESC, observation.module_code LIMIT 30`, params)
  ]);
  const totals = normalizeCounts(summary.rows[0] ?? {});
  const status = totals.failures > 0 ? "FAIL" : totals.warnings > 0 ? "CAUTION" : totals.observed > 0 ? "HEALTHY" : "AWAITING_EVIDENCE";
  return {
    generatedAt: new Date().toISOString(), days, status, summary: { ...totals, evidence: evidenceGrade(totals.observed_signals) },
    modules: modules.rows.map(normalizeCounts), recent: recent.rows, blockers: blockers.rows, sessions: sessions.rows
  };
}

function deriveObservation(row: any, observerCutoverAt: string | Date) {
  const flags = row.scenario_flags ?? {};
  const signalExpected = SIGNAL_STATUSES.includes(String(row.status)) || Boolean(row.trade_plan_id || row.trade_id);
  const brainAction = String(row.brain_metadata?.action ?? "");
  const predictionObserved = signalExpected || (["BUY", "SELL"].includes(brainAction) && Number(row.brain_metadata?.confidence ?? row.favorability_score ?? 0) >= 80);
  const signalObserved = Boolean(row.signal_notification_id);
  const paperExpected = signalExpected && flags.paperTrackingEligible !== false;
  const planObserved = Boolean(row.trade_plan_id);
  const tradeObserved = Boolean(row.trade_id);
  const targetsObserved = tradeObserved && Number(row.target_count) === 3;
  const journalObserved = Boolean(row.journal_id);
  const terminal = ["WIN", "LOSS", "BREAKEVEN"].includes(String(row.trade_outcome ?? ""));
  const terminalObserved = !terminal || Number(row.terminal_targets) > 0 || Boolean(row.terminal_event_type);
  const historicalBeforeObserver = new Date(row.detected_at).getTime() < new Date(observerCutoverAt).getTime();
  const mature = Date.now() - new Date(row.detected_at).getTime() >= ARTIFACT_GRACE_MINUTES * 60_000;
  const missing: string[] = [];
  if (signalExpected && !predictionObserved) missing.push("PREDICTION");
  if (signalExpected && !signalObserved) missing.push("BUY_SELL_NOTIFICATION");
  if (paperExpected && !planObserved) missing.push("TRADE_PLAN");
  if (paperExpected && !tradeObserved) missing.push("PAPER_TRADE");
  if (tradeObserved && !targetsObserved) missing.push("TP1_TP2_TP3");
  if (tradeObserved && !journalObserved) missing.push("JOURNAL");
  if (terminal && !terminalObserved) missing.push("TERMINAL_LIFECYCLE");
  const hardMissing = missing.filter((step) => ["BUY_SELL_NOTIFICATION", "TP1_TP2_TP3", "JOURNAL", "TERMINAL_LIFECYCLE"].includes(step));
  const status = !signalExpected
    ? "OBSERVING"
    : missing.length === 0
      ? "PASS"
      : historicalBeforeObserver
        ? "WARN"
        : !mature
          ? "OBSERVING"
          : hardMissing.length > 0
            ? "FAIL"
            : "WARN";
  return {
    status, signalExpected, predictionObserved, signalObserved, paperExpected, planObserved, tradeObserved,
    targetsObserved, journalObserved, terminalObserved, missing,
    evidence: {
      graceMinutes: ARTIFACT_GRACE_MINUTES, setupStatus: row.status, scenario: row.scenario, direction: row.direction,
      signalNotificationId: row.signal_notification_id ?? null, tradePlanId: row.trade_plan_id ?? null,
      tradeId: row.trade_id ?? null, tradeOutcome: row.trade_outcome ?? null, targetCount: Number(row.target_count ?? 0),
      terminalEventType: row.terminal_event_type ?? null,
      observerCutoverAt, historicalBeforeObserver,
      sessionDate: row.session_date, sessionPreset: row.session_preset, brainAction: brainAction || null
    }
  };
}

function normalizeCounts(row: any) {
  const copy = { ...row };
  for (const key of ["observed", "passed", "warnings", "failures", "observing", "expected_signals", "observed_signals", "paper_trades"]) {
    if (key in copy) copy[key] = Number(copy[key] ?? 0);
  }
  return copy;
}

function evidenceGrade(samples: number) {
  if (samples < 20) return { status: "EARLY", samples, nextThreshold: 20, message: `${samples}/20 observed signals; collect more full sessions before tuning.` };
  if (samples < 50) return { status: "RESEARCH", samples, nextThreshold: 50, message: `${samples}/50 observed signals; compare modules and blockers without automatic threshold changes.` };
  return { status: "MONITORABLE", samples, nextThreshold: null, message: `${samples} observed signals are available for production calibration review.` };
}
