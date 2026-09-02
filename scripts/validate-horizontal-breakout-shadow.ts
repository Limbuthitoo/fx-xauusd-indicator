import { existsSync, readFileSync } from "node:fs";

loadEnv(process.argv[2] ?? ".env.production");
const { pool, query } = await import("../apps/api/src/infrastructure/db/client.js");
const checks: Array<{ name: string; status: "PASS" | "WARN" | "FAIL"; detail: string; evidence?: unknown }> = [];

try {
  const migration = await query(
    "SELECT filename, applied_at FROM schema_migrations WHERE filename = '104_module1_horizontal_breakout_shadow_observer.sql'"
  );
  add("Shadow observer migration", migration.rows.length === 1, "Migration 104 is recorded.", "Migration 104 is missing.", migration.rows);
  const schema = await query(
    `SELECT
       to_regclass('public.module1_horizontal_candidate_audits') IS NOT NULL AS candidate_audits,
       to_regclass('public.module1_horizontal_breakout_shadows') IS NOT NULL AS breakout_shadows,
       to_regclass('public.module1_horizontal_breakout_shadow_calibration') IS NOT NULL AS calibration_view,
       to_regclass('public.module1_horizontal_breakout_shadows_active_idx') IS NOT NULL AS active_index,
       to_regclass('public.module1_horizontal_breakout_shadows_analysis_idx') IS NOT NULL AS analysis_index`
  );
  add("Shadow observer schema", Object.values(schema.rows[0] ?? {}).every(Boolean), "Shadow tables, view, and indexes are installed.", "Shadow observer schema is incomplete.", schema.rows[0]);
  if (checks.some((check) => check.status === "FAIL")) finish();

  const integrity = await query(
    `SELECT count(*)::int AS invalid_rows
     FROM module1_horizontal_breakout_shadows
     WHERE initial_risk_distance <= 0
        OR observation_until <= breakout_at
        OR (completed_at IS NOT NULL AND completed_at < breakout_at)
        OR (production_setup_ready AND rejection_stage IS NOT NULL)
        OR (tp3_hit_at IS NOT NULL AND tp2_hit_at IS NULL)
        OR (tp2_hit_at IS NOT NULL AND tp1_hit_at IS NULL)`
  );
  add("Shadow lifecycle integrity", Number(integrity.rows[0]?.invalid_rows ?? 0) === 0, "No invalid shadow lifecycle rows were found.", "Invalid shadow lifecycle rows exist.", integrity.rows[0]);

  const counts = await query(
    `SELECT
       count(*)::int AS observations,
       count(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completed,
       count(*) FILTER (WHERE production_setup_ready)::int AS production_controls,
       count(*) FILTER (WHERE NOT production_setup_ready)::int AS rejected_opportunities
     FROM module1_horizontal_breakout_shadows`
  );
  checks.push({
    name: "Observation sample",
    status: Number(counts.rows[0]?.completed ?? 0) >= 30 ? "PASS" : "WARN",
    detail: Number(counts.rows[0]?.completed ?? 0) >= 30
      ? "At least 30 completed shadow observations are available for guarded analysis."
      : "Observer is healthy; continue collecting completed New York sessions before tuning production rules.",
    evidence: counts.rows[0]
  });
  finish();
} catch (error) {
  checks.push({ name: "Shadow observer runtime", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
  finish();
} finally {
  await pool.end().catch(() => undefined);
}

function add(name: string, pass: boolean, ok: string, bad: string, evidence?: unknown) {
  checks.push({ name, status: pass ? "PASS" : "FAIL", detail: pass ? ok : bad, evidence });
}

function finish(): never {
  const failed = checks.some((check) => check.status === "FAIL");
  const warnings = checks.some((check) => check.status === "WARN");
  console.log(JSON.stringify({ status: failed ? "FAIL" : warnings ? "WARN" : "PASS", checks }, null, 2));
  process.exit(failed ? 1 : 0);
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
    if (!process.env[key]) process.env[key] = value.replace(/\$\$/g, "$");
  }
}
