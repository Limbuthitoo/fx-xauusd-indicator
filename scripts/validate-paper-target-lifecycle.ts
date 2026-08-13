import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

loadEnv(process.argv[2] ?? ".env.production");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? localDatabaseUrl() });
const checks: Array<{ name: string; status: "PASS" | "WARN" | "FAIL"; detail: string; evidence?: unknown }> = [];

try {
  await client.connect();

  const migration = (await rows(
    `SELECT filename, applied_at
     FROM schema_migrations
     WHERE filename = '082_paper_trade_multi_target_lifecycle.sql'`
  ))[0];
  add("Migration 082", Boolean(migration), "Migration 082 is recorded in the checksum ledger.", "Migration 082 is missing from schema_migrations.", migration);

  const analyticsMigration = (await rows(
    `SELECT filename, applied_at FROM schema_migrations WHERE filename = '083_target_performance_analytics.sql'`
  ))[0];
  checks.push({
    name: "Migration 083",
    status: analyticsMigration ? "PASS" : "WARN",
    detail: analyticsMigration
      ? "Target performance analytics migration is recorded in the checksum ledger."
      : "Migration 083 is not applied yet; lifecycle integrity can be checked, but target analytics are unavailable.",
    evidence: analyticsMigration ?? null
  });

  const schema = await rows(
    `SELECT
       to_regclass('public.paper_trade_targets') IS NOT NULL AS targets_table,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'structural_stop') AS structural_stop,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'initial_risk_distance') AS initial_risk,
       to_regclass('public.trade_events_paper_milestone_unique_idx') IS NOT NULL AS milestone_index`
  );
  const schemaRow = schema[0] ?? {};
  const schemaReady = Object.values(schemaRow).every(Boolean);
  add("Lifecycle schema", schemaReady, "Target table, structural-risk columns, and milestone uniqueness index are installed.", "The multi-target schema is incomplete.", schemaRow);

  if (!schemaReady) finish();

  if (analyticsMigration) {
    const analyticsSchema = (await rows(
      `SELECT to_regclass('public.paper_trade_target_performance') IS NOT NULL AS performance_view,
              to_regclass('public.paper_trade_targets_hit_status_idx') IS NOT NULL AS target_hit_index,
              to_regclass('public.trades_outcome_opened_idx') IS NOT NULL AS trade_outcome_index`
    ))[0] ?? {};
    add("Analytics schema", Object.values(analyticsSchema).every(Boolean), "Performance view and reporting indexes are installed.", "Target performance analytics schema is incomplete.", analyticsSchema);

    const analyticsConflicts = await rows(
      `SELECT trade_id, outcome, target_count, tp1_hit, tp2_hit, tp3_hit, sl_hit
       FROM paper_trade_target_performance
       WHERE (tp2_hit AND NOT tp1_hit) OR (tp3_hit AND NOT tp2_hit)
          OR (outcome = 'ACTIVE' AND (tp3_hit OR sl_hit))
       LIMIT 50`
    );
    add("Analytics lifecycle consistency", analyticsConflicts.length === 0, "Analytics contains no skipped milestone or active-terminal conflicts.", `${analyticsConflicts.length} analytics lifecycle conflict(s) found.`, analyticsConflicts);
  }

  const missingTargets = await rows(
    `SELECT t.id, sc.module_code, sc.direction, t.outcome, t.opened_at, count(ptt.id)::int AS target_count
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     LEFT JOIN paper_trade_targets ptt ON ptt.trade_id = t.id
     WHERE t.actual_entry IS NOT NULL
       AND t.actual_stop IS NOT NULL
       AND t.actual_target IS NOT NULL
       AND abs(t.actual_entry - t.actual_stop) > 0
       AND ((sc.direction = 'LONG' AND t.actual_stop < t.actual_entry AND t.actual_entry < t.actual_target)
         OR (sc.direction = 'SHORT' AND t.actual_target < t.actual_entry AND t.actual_entry < t.actual_stop))
     GROUP BY t.id, sc.module_code, sc.direction, t.outcome, t.opened_at
     HAVING count(ptt.id) <> 3
     ORDER BY t.opened_at DESC NULLS LAST
     LIMIT 50`
  );
  add("Three-target coverage", missingTargets.length === 0, "Every valid paper-trade geometry has exactly three persisted targets.", `${missingTargets.length} sampled trade(s) do not have exactly three targets.`, missingTargets);

  const invalidGeometry = await rows(
    `WITH target_geometry AS (
       SELECT t.id, sc.direction, t.actual_entry::numeric AS entry,
              COALESCE(t.structural_stop, t.actual_stop)::numeric AS stop,
              t.actual_target::numeric AS final_target,
              max(ptt.price) FILTER (WHERE ptt.target_number = 1) AS tp1,
              max(ptt.price) FILTER (WHERE ptt.target_number = 2) AS tp2,
              max(ptt.price) FILTER (WHERE ptt.target_number = 3) AS tp3,
              max(ptt.risk_multiple) FILTER (WHERE ptt.target_number = 1) AS r1,
              max(ptt.risk_multiple) FILTER (WHERE ptt.target_number = 2) AS r2,
              max(ptt.risk_multiple) FILTER (WHERE ptt.target_number = 3) AS r3
       FROM trades t
       JOIN trade_plans plan ON plan.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = plan.setup_candidate_id
       JOIN paper_trade_targets ptt ON ptt.trade_id = t.id
       GROUP BY t.id, sc.direction, t.actual_entry, COALESCE(t.structural_stop, t.actual_stop), t.actual_target
     )
     SELECT * FROM target_geometry
     WHERE stop IS NULL OR entry IS NULL OR tp1 IS NULL OR tp2 IS NULL OR tp3 IS NULL
        OR abs(tp3 - final_target) > 0.00011
        OR r1 > r2 OR r2 > r3
        OR (direction = 'LONG' AND NOT (stop < entry AND entry <= tp1 AND tp1 <= tp2 AND tp2 <= tp3))
        OR (direction = 'SHORT' AND NOT (tp3 <= tp2 AND tp2 <= tp1 AND tp1 <= entry AND entry < stop))
     LIMIT 50`
  );
  add("Target geometry", invalidGeometry.length === 0, "Persisted BUY and SELL target ladders are directionally ordered and TP3 matches the approved strategy target.", `${invalidGeometry.length} sampled target ladder(s) have invalid geometry.`, invalidGeometry);

  const invalidSnapshots = await rows(
    `SELECT id, actual_entry, actual_stop, structural_stop, initial_risk_distance, outcome
     FROM trades
     WHERE id IN (SELECT DISTINCT trade_id FROM paper_trade_targets)
       AND (structural_stop IS NULL OR initial_risk_distance IS NULL OR initial_risk_distance <= 0
         OR abs(initial_risk_distance - abs(actual_entry - structural_stop)) > 0.00011)
     LIMIT 50`
  );
  add("Structural-risk snapshots", invalidSnapshots.length === 0, "Every target lifecycle preserves a valid structural SL and initial R distance.", `${invalidSnapshots.length} sampled lifecycle trade(s) have an invalid risk snapshot.`, invalidSnapshots);

  const invalidTargetState = await rows(
    `SELECT trade_id, target_number, status, hit_at, hit_price
     FROM paper_trade_targets
     WHERE (status = 'HIT' AND (hit_at IS NULL OR hit_price IS NULL))
        OR (status <> 'HIT' AND (hit_at IS NOT NULL OR hit_price IS NOT NULL))
     LIMIT 50`
  );
  add("Target state integrity", invalidTargetState.length === 0, "Target status, hit timestamp, and hit price agree.", `${invalidTargetState.length} sampled target state row(s) are inconsistent.`, invalidTargetState);

  const duplicateEvents = await rows(
    `SELECT trade_id, event_type, count(*)::int AS occurrences
     FROM trade_events
     WHERE event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT', 'PAPER_SL_HIT')
     GROUP BY trade_id, event_type
     HAVING count(*) > 1`
  );
  add("Idempotent milestones", duplicateEvents.length === 0, "No paper trade has duplicate TP/SL milestone events.", `${duplicateEvents.length} duplicate milestone group(s) exist.`, duplicateEvents);

  const invalidClosures = await rows(
    `SELECT t.id, sc.direction, t.outcome, t.actual_entry, t.actual_exit,
            t.structural_stop, t.initial_risk_distance, t.result_r,
            ((t.actual_exit - t.actual_entry) * CASE WHEN sc.direction = 'SHORT' THEN -1 ELSE 1 END)
              / NULLIF(t.initial_risk_distance, 0) AS expected_r
     FROM trades t
     JOIN trade_plans plan ON plan.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = plan.setup_candidate_id
     WHERE t.closed_at >= COALESCE($1::timestamptz, '-infinity'::timestamptz)
       AND t.actual_exit IS NOT NULL
       AND t.result_r IS NOT NULL
       AND t.initial_risk_distance > 0
       AND abs(t.result_r - (((t.actual_exit - t.actual_entry) * CASE WHEN sc.direction = 'SHORT' THEN -1 ELSE 1 END)
         / t.initial_risk_distance)) > 0.011
     LIMIT 50`,
    [migration?.applied_at ?? null]
  );
  add("Realized R", invalidClosures.length === 0, "Post-migration realized R is calculated from final exit and initial structural risk; no partial exits are implied.", `${invalidClosures.length} sampled closeout(s) have inconsistent realized R.`, invalidClosures);

  const lifecycleCounts = (await rows(
    `SELECT
       count(*) FILTER (WHERE event_type = 'PAPER_TP1_HIT')::int AS tp1_hits,
       count(*) FILTER (WHERE event_type = 'PAPER_TP2_HIT')::int AS tp2_hits,
       count(*) FILTER (WHERE event_type = 'PAPER_TP3_HIT')::int AS tp3_hits,
       count(*) FILTER (WHERE event_type = 'PAPER_SL_HIT')::int AS sl_hits
     FROM trade_events
     WHERE created_at >= COALESCE($1::timestamptz, '-infinity'::timestamptz)`,
    [migration?.applied_at ?? null]
  ))[0] ?? {};
  const observed = Object.values(lifecycleCounts).some((value) => Number(value) > 0);
  checks.push({
    name: "Live lifecycle evidence",
    status: observed ? "PASS" : "WARN",
    detail: observed
      ? "At least one real post-migration TP/SL milestone has been observed."
      : "No real post-migration TP/SL milestone has occurred yet. Keep monitoring; deterministic BUY/SELL sequence tests provide code-level proof only.",
    evidence: lifecycleCounts
  });

  const missingNotifications = await rows(
    `SELECT e.trade_id, e.event_type, e.created_at
     FROM trade_events e
     WHERE e.created_at >= COALESCE($1::timestamptz, '-infinity'::timestamptz)
       AND e.event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT')
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.data->>'tradeId' = e.trade_id::text
           AND n.event_type = e.event_type
       )
     LIMIT 50`,
    [migration?.applied_at ?? null]
  );
  add("Target notifications", missingNotifications.length === 0, "Every observed post-migration TP milestone has a matching detailed notification.", `${missingNotifications.length} TP milestone notification(s) are missing.`, missingNotifications);

  finish();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}

function add(name: string, ok: boolean, pass: string, fail: string, evidence?: unknown) {
  checks.push({ name, status: ok ? "PASS" : "FAIL", detail: ok ? pass : fail, ...(evidence === undefined ? {} : { evidence }) });
}

function finish(): never {
  const failed = checks.filter((check) => check.status === "FAIL");
  const warnings = checks.filter((check) => check.status === "WARN");
  console.log(JSON.stringify({
    status: failed.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS",
    generatedAt: new Date().toISOString(),
    summary: { pass: checks.length - failed.length - warnings.length, warn: warnings.length, fail: failed.length },
    checks
  }, null, 2));
  process.exit(failed.length > 0 ? 1 : 0);
}

async function rows(text: string, params: unknown[] = []) {
  return (await client.query(text, params)).rows;
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
