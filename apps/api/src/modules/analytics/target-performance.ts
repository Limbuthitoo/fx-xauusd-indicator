import { query } from "../../infrastructure/db/client.js";

export type TargetPerformancePeriod = "week" | "month";

type PerformanceRow = {
  trade_id: string; profile_code: string | null; profile_name: string | null; outcome: string | null;
  result_r: number | string | null; holding_seconds: number | string | null; target_count: number | string;
  tp1_hit: boolean; tp2_hit: boolean; tp3_hit: boolean; sl_hit: boolean;
  stopped_after_tp1: boolean; stopped_after_tp2: boolean;
};

export async function buildTargetPerformanceReport(tenantId: string, moduleCode: string, period: TargetPerformancePeriod) {
  const result = await query(
    `SELECT trade_id, profile_code, profile_name, outcome, result_r, holding_seconds,
            target_count, tp1_hit, tp2_hit, tp3_hit, sl_hit, stopped_after_tp1, stopped_after_tp2
     FROM paper_trade_target_performance
     WHERE tenant_id = $1 AND module_code = $2 AND is_qa = false
       AND opened_at >= date_trunc($3, now()) ORDER BY opened_at ASC`,
    [tenantId, moduleCode, period]
  );
  const rows = result.rows as PerformanceRow[];
  return { period, moduleCode, generatedAt: new Date().toISOString(), summary: summarizeTargetPerformance(rows), byProfile: profilePerformance(rows) };
}

export function summarizeTargetPerformance(rows: PerformanceRow[]) {
  const decided = rows.filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(String(row.outcome ?? "")));
  const wins = decided.filter((row) => row.outcome === "WIN").length;
  const losses = decided.filter((row) => row.outcome === "LOSS").length;
  const tp1Hits = rows.filter((row) => row.tp1_hit).length;
  const tp2Hits = rows.filter((row) => row.tp2_hit).length;
  const tp3Hits = rows.filter((row) => row.tp3_hit).length;
  const stopAfterTp1 = rows.filter((row) => row.stopped_after_tp1).length;
  const stopAfterTp2 = rows.filter((row) => row.stopped_after_tp2).length;
  const results = decided.map((row) => num(row.result_r)).filter(Number.isFinite);
  const grossProfit = results.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(results.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const holdSeconds = decided.map((row) => num(row.holding_seconds)).filter((value) => Number.isFinite(value) && value >= 0);
  return {
    trades: rows.length, decided: decided.length, active: rows.filter((row) => row.outcome === "ACTIVE").length,
    wins, losses, winRate: ratio(wins, decided.length), tp1Hits, tp2Hits, tp3Hits,
    slHits: rows.filter((row) => row.sl_hit).length,
    tp1ReachRate: ratio(tp1Hits, rows.length), tp2ReachRate: ratio(tp2Hits, rows.length), tp3ReachRate: ratio(tp3Hits, rows.length),
    tp1ToTp2: ratio(tp2Hits, tp1Hits), tp2ToTp3: ratio(tp3Hits, tp2Hits),
    stopAfterTp1, stopAfterTp2, stopAfterTp1Rate: ratio(stopAfterTp1, tp1Hits), stopAfterTp2Rate: ratio(stopAfterTp2, tp2Hits),
    expectancyR: average(results), profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    totalR: round(results.reduce((sum, value) => sum + value, 0)), averageHoldSeconds: average(holdSeconds),
    targetCoverageComplete: rows.length > 0 && rows.every((row) => num(row.target_count) === 3), evidence: evidenceGrade(decided.length)
  };
}

function profilePerformance(rows: PerformanceRow[]) {
  const grouped = new Map<string, PerformanceRow[]>();
  for (const row of rows) { const code = String(row.profile_code ?? "UNCLASSIFIED"); grouped.set(code, [...(grouped.get(code) ?? []), row]); }
  return [...grouped.entries()].map(([profileCode, items]) => ({ profileCode, profileName: items[0]?.profile_name ?? profileCode, ...summarizeTargetPerformance(items) }))
    .sort((left, right) => right.trades - left.trades || String(left.profileName).localeCompare(String(right.profileName)));
}

function evidenceGrade(samples: number) {
  if (samples < 20) return { status: "EARLY", trustworthy: false, minimumRequired: 20, message: `Early evidence only: ${samples}/20 closed trades.` };
  if (samples < 50) return { status: "RESEARCH", trustworthy: false, minimumRequired: 50, message: `Research sample: ${samples}/50 closed trades before monitored trust.` };
  return { status: "MONITORABLE", trustworthy: true, minimumRequired: 50, message: `${samples} closed trades are available for monitored paper-performance review.` };
}
function ratio(a: number, b: number) { return b > 0 ? round(a / b) : 0; }
function average(values: number[]) { return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0; }
function num(value: unknown) { return Number(value ?? 0); }
function round(value: number) { return Number(value.toFixed(4)); }
