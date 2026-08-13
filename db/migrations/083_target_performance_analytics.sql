CREATE OR REPLACE VIEW paper_trade_target_performance AS
WITH target_state AS (
  SELECT trade_id, count(*)::int AS target_count,
    bool_or(target_number = 1 AND status = 'HIT') AS tp1_hit,
    bool_or(target_number = 2 AND status = 'HIT') AS tp2_hit,
    bool_or(target_number = 3 AND status = 'HIT') AS tp3_hit,
    max(hit_at) FILTER (WHERE target_number = 1 AND status = 'HIT') AS tp1_hit_at,
    max(hit_at) FILTER (WHERE target_number = 2 AND status = 'HIT') AS tp2_hit_at,
    max(hit_at) FILTER (WHERE target_number = 3 AND status = 'HIT') AS tp3_hit_at
  FROM paper_trade_targets GROUP BY trade_id
), milestone_state AS (
  SELECT trade_id,
    bool_or(event_type = 'PAPER_SL_HIT') AS sl_hit,
    max(created_at) FILTER (WHERE event_type = 'PAPER_SL_HIT') AS sl_hit_at
  FROM trade_events
  WHERE event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT', 'PAPER_SL_HIT')
  GROUP BY trade_id
)
SELECT t.id AS trade_id, sc.tenant_id, sc.module_code, sc.scenario, sc.direction,
  CASE WHEN sc.module_code = 'high_probability_strategy_2'
    THEN COALESCE(sc.scenario_flags->'module2Variant'->>'code', sc.scenario_flags->>'variantCode', sc.scenario)
    ELSE sc.scenario END AS profile_code,
  CASE WHEN sc.module_code = 'high_probability_strategy_2'
    THEN COALESCE(sc.scenario_flags->'module2Variant'->>'name', sc.scenario_flags->>'variantName', sc.scenario)
    ELSE replace(initcap(lower(sc.scenario)), '_', ' ') END AS profile_name,
  t.outcome, t.result_r::float AS result_r, t.opened_at, t.closed_at,
  CASE WHEN t.closed_at IS NOT NULL AND t.opened_at IS NOT NULL
    THEN extract(epoch FROM (t.closed_at - t.opened_at))::float ELSE NULL END AS holding_seconds,
  COALESCE(ts.target_count, 0) AS target_count,
  COALESCE(ts.tp1_hit, false) AS tp1_hit, COALESCE(ts.tp2_hit, false) AS tp2_hit,
  COALESCE(ts.tp3_hit, false) AS tp3_hit, ts.tp1_hit_at, ts.tp2_hit_at, ts.tp3_hit_at,
  COALESCE(ms.sl_hit, false) AS sl_hit, ms.sl_hit_at,
  COALESCE(ms.sl_hit, false) AND COALESCE(ts.tp1_hit, false) AND NOT COALESCE(ts.tp2_hit, false) AS stopped_after_tp1,
  COALESCE(ms.sl_hit, false) AND COALESCE(ts.tp2_hit, false) AND NOT COALESCE(ts.tp3_hit, false) AS stopped_after_tp2,
  sc.scenario = 'QA_TEST_SIGNAL' OR COALESCE(sc.scenario_flags->>'replay', 'false') = 'true' AS is_qa
FROM trades t
JOIN trade_plans tp ON tp.id = t.trade_plan_id
JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
LEFT JOIN target_state ts ON ts.trade_id = t.id
LEFT JOIN milestone_state ms ON ms.trade_id = t.id;

CREATE INDEX IF NOT EXISTS paper_trade_targets_hit_status_idx ON paper_trade_targets (status, target_number, hit_at DESC);
CREATE INDEX IF NOT EXISTS trades_outcome_opened_idx ON trades (outcome, opened_at DESC);

COMMENT ON VIEW paper_trade_target_performance IS
  'Tenant-scoped source cohort for TP milestone reach, conversion, stop-after-progress, expectancy, profit factor, and holding-time analytics.';
