import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import {
  evaluateSignalGeometryQuality,
  XAUUSD_PRODUCTION_SIGNAL_POLICY
} from "../packages/risk-engine/src/index.js";

loadEnv(process.argv[2] ?? ".env.production");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? localDatabaseUrl() });
const checks: Array<{ name: string; status: "PASS" | "WARN" | "FAIL"; detail: string; evidence?: unknown }> = [];

try {
  await client.connect();
  const rows = (await client.query(
    `SELECT tp.id AS plan_id,
            tp.signal_thesis_key,
            COALESCE(tp.promoted_at, tp.created_at) AS signal_at,
            tp.planned_entry,
            tp.planned_stop,
            tp.planned_target,
            tp.reward_to_risk,
            sc.id AS setup_id,
            sc.tenant_id,
            sc.module_code,
            sc.scenario,
            sc.direction,
            sc.favorability_score,
            sc.scenario_flags,
            ts.session_date,
            EXISTS (SELECT 1 FROM notifications n
                    WHERE n.tenant_id = sc.tenant_id
                      AND n.data->>'signalThesisKey' = tp.signal_thesis_key) AS has_notification,
            EXISTS (SELECT 1 FROM trades t WHERE t.trade_plan_id = tp.id) AS has_paper_trade,
            EXISTS (SELECT 1 FROM journal_entries je
                    WHERE je.setup_candidate_id = sc.id) AS has_journal
     FROM trade_plans tp
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     JOIN trading_sessions ts ON ts.id = sc.session_id
     WHERE tp.signal_thesis_key IS NOT NULL
       AND COALESCE(tp.promoted_at, tp.created_at) >= now() - interval '8 days'
       AND sc.module_code IN ('orb_max_options', 'high_probability_strategy_2')
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
       AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
       AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'
     ORDER BY sc.tenant_id, ts.session_date, signal_at`
  )).rows;

  const assessed = rows.map((row) => {
    const geometry = evaluateSignalGeometryQuality({
      direction: String(row.direction ?? ""),
      entry: Number(row.planned_entry),
      stop: Number(row.planned_stop),
      target: Number(row.planned_target),
      pipSize: XAUUSD_PRODUCTION_SIGNAL_POLICY.pipSize,
      minimumTp1Pips: XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumTp1Pips,
      minimumFinalRewardToRisk: XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumFinalRewardToRisk
    });
    const score = Number(row.favorability_score);
    return {
      ...row,
      strategy_profile: strategyProfile(row),
      score: Number.isFinite(score) ? score : null,
      quality_passed: geometry.passed && score >= XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumEvidenceScore,
      tp1_pips: geometry.tp1Pips,
      final_rr: Number(geometry.finalRewardToRisk.toFixed(2)),
      quality_reasons: [
        ...geometry.reasons,
        ...(score >= XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumEvidenceScore
          ? []
          : [`Evidence score ${Number.isFinite(score) ? score : "missing"}/100 is below ${XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumEvidenceScore}/100.`])
      ]
    };
  });

  checks.push({
    name: "Promoted production signal sample",
    status: assessed.length > 0 ? "PASS" : "WARN",
    detail: assessed.length > 0
      ? `${assessed.length} genuine promoted signal contract(s) were inspected.`
      : "No genuine promoted signal contracts exist in the last eight days; policy wiring is installed but live proof is pending."
  });

  const badQuality = assessed.filter((row) => !row.quality_passed);
  checks.push({
    name: "Signal geometry and evidence quality",
    status: badQuality.length === 0 ? "PASS" : "FAIL",
    detail: badQuality.length === 0
      ? `Every promoted contract meets ${XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumEvidenceScore}/100 evidence, ${XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumTp1Pips}-pip TP1, and ${XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumFinalRewardToRisk}R final-target policy.`
      : `${badQuality.length} promoted contract(s) violate the production quality policy.`,
    evidence: badQuality.slice(0, 20).map(signalEvidence)
  });

  const thesisCounts = groupBy(assessed, (row) => String(row.signal_thesis_key));
  const duplicateTheses = [...thesisCounts.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([key, values]) => ({ signalThesisKey: key, count: values.length, plans: values.map((row) => row.plan_id) }));
  checks.push({
    name: "Immutable thesis deduplication",
    status: duplicateTheses.length === 0 ? "PASS" : "FAIL",
    detail: duplicateTheses.length === 0 ? "Every market thesis has one immutable promoted contract." : `${duplicateTheses.length} duplicate signal thesis/theses found.`,
    evidence: duplicateTheses.slice(0, 20)
  });

  const dailyGroups = groupBy(assessed, (row) => `${row.tenant_id}:${dateOnly(row.session_date)}`);
  const dailyBreaches = [...dailyGroups.entries()]
    .filter(([, values]) => values.length > XAUUSD_PRODUCTION_SIGNAL_POLICY.maximumSignalsPerNewYorkDate)
    .map(([key, values]) => ({ key, count: values.length, maximum: XAUUSD_PRODUCTION_SIGNAL_POLICY.maximumSignalsPerNewYorkDate }));
  checks.push({
    name: "Shared daily signal limit",
    status: dailyBreaches.length === 0 ? "PASS" : "FAIL",
    detail: dailyBreaches.length === 0
      ? `No subscriber exceeded ${XAUUSD_PRODUCTION_SIGNAL_POLICY.maximumSignalsPerNewYorkDate} promoted signals per New York date.`
      : `${dailyBreaches.length} subscriber-day limit breach(es) found.`,
    evidence: dailyBreaches
  });

  const profileGroups = groupBy(assessed, (row) => `${row.tenant_id}:${dateOnly(row.session_date)}:${row.module_code}:${row.strategy_profile}`);
  const profileBreaches = [...profileGroups.entries()]
    .filter(([, values]) => values.length > XAUUSD_PRODUCTION_SIGNAL_POLICY.maximumSignalsPerStrategyProfile)
    .map(([key, values]) => ({ key, count: values.length, maximum: XAUUSD_PRODUCTION_SIGNAL_POLICY.maximumSignalsPerStrategyProfile }));
  const cooldownBreaches = [...profileGroups.entries()].flatMap(([key, values]) => {
    const sorted = [...values].sort((a, b) => new Date(a.signal_at).getTime() - new Date(b.signal_at).getTime());
    return sorted.slice(1).flatMap((row, index) => {
      const minutes = (new Date(row.signal_at).getTime() - new Date(sorted[index].signal_at).getTime()) / 60_000;
      return minutes + 0.001 < XAUUSD_PRODUCTION_SIGNAL_POLICY.sameProfileCooldownMinutes
        ? [{ key, previousPlan: sorted[index].plan_id, plan: row.plan_id, elapsedMinutes: Number(minutes.toFixed(1)) }]
        : [];
    });
  });
  checks.push({
    name: "Strategy-profile frequency policy",
    status: profileBreaches.length === 0 && cooldownBreaches.length === 0 ? "PASS" : "FAIL",
    detail: profileBreaches.length === 0 && cooldownBreaches.length === 0
      ? `Independent profiles stay within ${XAUUSD_PRODUCTION_SIGNAL_POLICY.maximumSignalsPerStrategyProfile} signals/day and ${XAUUSD_PRODUCTION_SIGNAL_POLICY.sameProfileCooldownMinutes}-minute same-profile cooldown.`
      : `${profileBreaches.length} profile-count and ${cooldownBreaches.length} cooldown breach(es) found.`,
    evidence: { profileBreaches, cooldownBreaches: cooldownBreaches.slice(0, 20) }
  });

  const missingPrimary = assessed.filter((row) => !row.has_notification);
  const missingSecondary = assessed.filter((row) => !row.has_paper_trade || !row.has_journal);
  checks.push({
    name: "BUY/SELL notification lifecycle",
    status: missingPrimary.length === 0 ? "PASS" : "FAIL",
    detail: missingPrimary.length === 0 ? "Every promoted BUY/SELL contract has its tenant notification." : `${missingPrimary.length} promoted contract(s) are missing their primary notification.`,
    evidence: missingPrimary.slice(0, 20).map(signalEvidence)
  });
  checks.push({
    name: "Secondary paper and journal audit",
    status: missingSecondary.length === 0 ? "PASS" : "WARN",
    detail: missingSecondary.length === 0
      ? "Every promoted signal has paper-performance and journal artifacts."
      : `${missingSecondary.length} promoted signal(s) lack paper or journal tracking; BUY/SELL remains the primary MVP artifact.`,
    evidence: missingSecondary.slice(0, 20).map(signalEvidence)
  });

  const profileSummary = [...profileGroups.entries()].map(([key, values]) => ({
    key,
    signals: values.length,
    notified: values.filter((row) => row.has_notification).length,
    paperTracked: values.filter((row) => row.has_paper_trade).length,
    averageScore: Number((values.reduce((sum, row) => sum + Number(row.score ?? 0), 0) / values.length).toFixed(1))
  }));
  checks.push({
    name: "Independent strategy-profile evidence",
    status: profileSummary.length > 0 ? "PASS" : "WARN",
    detail: profileSummary.length > 0 ? `${profileSummary.length} subscriber/date/profile evidence group(s) are auditable.` : "Profile evidence will appear after the next genuine signal.",
    evidence: profileSummary.slice(-30)
  });
} catch (error) {
  checks.push({ name: "Signal policy validator", status: "FAIL", detail: formatError(error) });
} finally {
  await client.end().catch(() => undefined);
}

const failed = checks.filter((check) => check.status === "FAIL");
const warnings = checks.filter((check) => check.status === "WARN");
console.log(JSON.stringify({
  status: failed.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS",
  policy: XAUUSD_PRODUCTION_SIGNAL_POLICY,
  generatedAt: new Date().toISOString(),
  checks
}, null, 2));
if (failed.length > 0) process.exit(1);

function strategyProfile(row: any) {
  if (row.module_code === "high_probability_strategy_2") {
    return row.scenario_flags?.module2Variant?.code ?? row.scenario_flags?.variantCode ?? row.scenario ?? "UNCLASSIFIED";
  }
  const scenario = String(row.scenario ?? "ORB_BREAKOUT").toUpperCase();
  if (scenario.includes("HORIZONTAL")) return "HORIZONTAL_RANGE_BREAKOUT";
  if (scenario.includes("OPENING_DRIVE")) return "OPENING_DRIVE";
  if (scenario.includes("LIQUIDITY_SWEEP")) return "LIQUIDITY_SWEEP_REVERSAL";
  if (scenario.includes("RETEST")) return "BREAKOUT_RETEST";
  return "ORB_BREAKOUT";
}

function signalEvidence(row: any) {
  return {
    planId: row.plan_id,
    setupId: row.setup_id,
    moduleCode: row.module_code,
    strategyProfile: row.strategy_profile,
    direction: row.direction,
    signalAt: row.signal_at,
    score: row.score,
    tp1Pips: row.tp1_pips,
    finalRR: row.final_rr,
    reasons: row.quality_reasons,
    notification: row.has_notification,
    paperTrade: row.has_paper_trade,
    journal: row.has_journal
  };
}

function groupBy<T>(values: T[], key: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value]);
  return groups;
}

function dateOnly(value: unknown) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "UNKNOWN").slice(0, 10);
}

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors.map((item) => item instanceof Error ? item.message : String(item)).filter(Boolean);
    return details.length > 0 ? details.join(" | ") : "Database connection failed with no additional detail.";
  }
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function localDatabaseUrl() {
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "orb_password");
  return `postgres://${process.env.POSTGRES_USER ?? "orb_user"}:${password}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "orb_guide"}`;
}

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
