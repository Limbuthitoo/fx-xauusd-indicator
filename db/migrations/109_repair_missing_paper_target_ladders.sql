UPDATE trades
SET structural_stop = COALESCE(structural_stop, actual_stop),
    initial_risk_distance = COALESCE(initial_risk_distance, abs(actual_entry - COALESCE(structural_stop, actual_stop)))
WHERE outcome = 'ACTIVE'
  AND actual_entry IS NOT NULL
  AND actual_stop IS NOT NULL
  AND (structural_stop IS NULL OR initial_risk_distance IS NULL);

WITH missing_ladders AS (
  SELECT
    trade.id AS trade_id,
    trade.actual_entry::numeric AS entry,
    COALESCE(trade.structural_stop, trade.actual_stop)::numeric AS stop,
    trade.actual_target::numeric AS final_target,
    CASE WHEN setup.direction = 'SHORT' THEN -1::numeric ELSE 1::numeric END AS direction_multiplier,
    abs(trade.actual_entry - COALESCE(trade.structural_stop, trade.actual_stop))::numeric AS risk_distance,
    abs(trade.actual_target - trade.actual_entry)
      / NULLIF(abs(trade.actual_entry - COALESCE(trade.structural_stop, trade.actual_stop)), 0) AS final_r
  FROM trades trade
  JOIN trade_plans plan ON plan.id = trade.trade_plan_id
  JOIN setup_candidates setup ON setup.id = plan.setup_candidate_id
  WHERE trade.outcome = 'ACTIVE'
    AND trade.actual_entry IS NOT NULL
    AND trade.actual_target IS NOT NULL
    AND COALESCE(trade.structural_stop, trade.actual_stop) IS NOT NULL
    AND abs(trade.actual_entry - COALESCE(trade.structural_stop, trade.actual_stop)) > 0
    AND NOT EXISTS (
      SELECT 1 FROM paper_trade_targets target WHERE target.trade_id = trade.id
    )
), target_plan AS (
  SELECT
    missing.trade_id,
    target.target_number,
    round(missing.entry + missing.direction_multiplier * missing.risk_distance * target.risk_multiple, 5) AS price,
    round(target.risk_multiple, 4) AS risk_multiple,
    target.position_fraction
  FROM missing_ladders missing
  CROSS JOIN LATERAL (VALUES
    (1::smallint, least(1::numeric, missing.final_r), 0.333333::numeric),
    (2::smallint, least(1.5::numeric, missing.final_r), 0.333333::numeric),
    (3::smallint, missing.final_r, 0.333334::numeric)
  ) target(target_number, risk_multiple, position_fraction)
  WHERE missing.final_r > 0
)
INSERT INTO paper_trade_targets (
  trade_id, target_number, price, risk_multiple, status,
  position_fraction, realized_r, metadata
)
SELECT
  trade_id,
  target_number,
  price,
  risk_multiple,
  'PENDING',
  position_fraction,
  NULL,
  '{"source":"MIGRATION_109_ACTIVE_LADDER_REPAIR"}'::jsonb
FROM target_plan
ON CONFLICT (trade_id, target_number) DO NOTHING;

WITH repaired AS (
  SELECT target.trade_id
  FROM paper_trade_targets target
  WHERE target.metadata->>'source' = 'MIGRATION_109_ACTIVE_LADDER_REPAIR'
  GROUP BY target.trade_id
  HAVING count(*) = 3
)
INSERT INTO trade_events (trade_id, event_type, payload)
SELECT
  repaired.trade_id,
  'PAPER_TARGET_LADDER_REPAIRED',
  jsonb_build_object(
    'mode', 'PAPER',
    'targets', 3,
    'source', 'MIGRATION_109_ACTIVE_LADDER_REPAIR'
  )
FROM repaired
WHERE NOT EXISTS (
  SELECT 1
  FROM trade_events event
  WHERE event.trade_id = repaired.trade_id
    AND event.event_type = 'PAPER_TARGET_LADDER_REPAIRED'
);

COMMENT ON TABLE paper_trade_targets IS
  'Paper-position target milestones. Every executable paper trade has one immutable three-target ladder; TP3 closes the runner.';
