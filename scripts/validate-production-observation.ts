import { existsSync, readFileSync } from "node:fs";

loadEnv(process.argv[2] ?? ".env.production");

const { pool, query } = await import("../apps/api/src/infrastructure/db/client.js");
const { buildProductionObservationReport, refreshProductionSignalObservations } = await import("../apps/api/src/modules/observations/service.js");
const checks: Array<{ name: string; status: "PASS" | "WARN" | "FAIL"; detail: string; evidence?: unknown }> = [];

try {
  const migration = await query(
    "SELECT filename, applied_at FROM schema_migrations WHERE filename IN ('084_production_signal_observation.sql', '085_production_observer_query_indexes.sql') ORDER BY filename"
  );
  add("Observation migrations", migration.rows.length === 2, "Production observation migrations 084 and 085 are recorded.", "Observation migration 084 or 085 is missing.", migration.rows);

  const schema = await query(
    `SELECT to_regclass('public.production_signal_observations') IS NOT NULL AS observation_table,
            to_regclass('public.production_signal_observations_tenant_module_idx') IS NOT NULL AS tenant_module_index,
            to_regclass('public.production_signal_observations_status_idx') IS NOT NULL AS status_index,
            to_regclass('public.setup_candidates_observer_scan_idx') IS NOT NULL AS candidate_scan_index,
            to_regclass('public.notifications_setup_signal_idx') IS NOT NULL AS signal_lookup_index,
            to_regclass('public.operational_events_brain_setup_idx') IS NOT NULL AS brain_lookup_index,
            to_regclass('public.journal_entries_setup_tenant_idx') IS NOT NULL AS journal_lookup_index,
            to_regclass('public.trade_events_terminal_lookup_idx') IS NOT NULL AS terminal_lookup_index`
  );
  add("Observation schema", Object.values(schema.rows[0] ?? {}).every(Boolean), "Observation table and indexes are installed.", "Observation schema is incomplete.", schema.rows[0]);

  if (checks.some((check) => check.status === "FAIL")) finish();
  const refresh = await refreshProductionSignalObservations({ days: 7 });
  const report = await buildProductionObservationReport({ days: 7 });
  add("Observer refresh", true, `Observer inspected ${refresh.observed} genuine setup candidate(s).`, "Observer refresh failed.", refresh);
  add("Signal lifecycle failures", Number(report.summary.failures ?? 0) === 0,
    "No mature setup is missing required BUY/SELL or secondary audit artifacts.",
    `${report.summary.failures} mature setup chain(s) are incomplete.`, report.recent.filter((row: any) => row.observation_status === "FAIL"));
  checks.push({
    name: "Production evidence sample",
    status: report.summary.evidence?.status === "MONITORABLE" ? "PASS" : "WARN",
    detail: report.summary.evidence?.message ?? "No observed signal evidence yet.",
    evidence: report.summary.evidence
  });
  checks.push({
    name: "Genuine end-to-end signal",
    status: Number(report.summary.observed_signals ?? 0) > 0 ? "PASS" : "WARN",
    detail: Number(report.summary.observed_signals ?? 0) > 0
      ? `${report.summary.observed_signals} genuine BUY/SELL signal artifact(s) observed.`
      : "No genuine post-observer BUY/SELL signal has occurred yet; keep the worker running through full New York sessions.",
    evidence: report.modules
  });
  finish();
} catch (error) {
  checks.push({ name: "Observer runtime", status: "FAIL", detail: describeError(error) });
  finish();
} finally {
  await pool.end().catch(() => undefined);
}

function add(name: string, pass: boolean, ok: string, bad: string, evidence?: unknown) {
  checks.push({ name, status: pass ? "PASS" : "FAIL", detail: pass ? ok : bad, evidence });
}

function finish(): never {
  const failed = checks.filter((check) => check.status === "FAIL").length;
  console.log(JSON.stringify({ status: failed ? "FAIL" : "PASS", checks }, null, 2));
  process.exit(failed ? 1 : 0);
}

function describeError(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : String(error);
  } catch {
    return String(error);
  }
}

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value.replace(/\$\$/g, "$" );
  }
}
