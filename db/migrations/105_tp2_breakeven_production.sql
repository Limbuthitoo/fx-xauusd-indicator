ALTER TABLE trades
  ALTER COLUMN management_policy SET DEFAULT 'TP1_SCALE_OUT_TP2_BREAKEVEN_V3';

COMMENT ON COLUMN trades.management_policy IS
  'Immutable paper runner policy. Production V3 books TP1 without tightening the structural stop and moves the remaining runner to exact breakeven only after TP2.';

INSERT INTO trade_events (trade_id, event_type, payload)
SELECT
  t.id,
  'PAPER_MANAGEMENT_POLICY_MIGRATED',
  jsonb_strip_nulls(jsonb_build_object(
    'previousPolicy', t.management_policy,
    'managementPolicy', 'TP1_SCALE_OUT_TP2_BREAKEVEN_V3',
    'previousStop', t.actual_stop,
    'structuralStop', t.structural_stop,
    'reason', 'Production breakeven activation moved from TP1 to TP2'
  ))
FROM trades t
WHERE t.outcome = 'ACTIVE'
  AND t.management_policy = 'EQUAL_THIRDS_TP1_BREAKEVEN_V1';

WITH target_state AS (
  SELECT
    trade_id,
    min(hit_at) FILTER (WHERE target_number = 2 AND status = 'HIT') AS tp2_hit_at
  FROM paper_trade_targets
  GROUP BY trade_id
)
UPDATE trades t
SET management_policy = 'TP1_SCALE_OUT_TP2_BREAKEVEN_V3',
    actual_stop = CASE
      WHEN target_state.tp2_hit_at IS NOT NULL THEN t.actual_entry
      ELSE COALESCE(t.structural_stop, t.actual_stop)
    END,
    runner_protection_activated_at = NULL,
    breakeven_activated_at = target_state.tp2_hit_at
FROM target_state
WHERE target_state.trade_id = t.id
  AND t.outcome = 'ACTIVE'
  AND t.management_policy = 'EQUAL_THIRDS_TP1_BREAKEVEN_V1';

UPDATE trades
SET management_policy = 'TP1_SCALE_OUT_TP2_BREAKEVEN_V3',
    actual_stop = COALESCE(structural_stop, actual_stop),
    runner_protection_activated_at = NULL,
    breakeven_activated_at = NULL
WHERE outcome = 'ACTIVE'
  AND management_policy = 'EQUAL_THIRDS_TP1_BREAKEVEN_V1';

UPDATE positions p
SET current_stop = t.actual_stop,
    current_open_risk = CASE
      WHEN t.breakeven_activated_at IS NOT NULL THEN 0
      ELSE p.planned_risk_amount * t.remaining_fraction
    END,
    metadata = (p.metadata - 'runnerProtectionActivatedAt' - 'breakevenActivatedAt') || jsonb_strip_nulls(jsonb_build_object(
      'managementModel', t.management_policy,
      'stopManagement', CASE WHEN t.breakeven_activated_at IS NULL THEN 'STRUCTURAL' ELSE 'BREAKEVEN' END,
      'breakevenActivatedAt', t.breakeven_activated_at
    )),
    updated_at = now()
FROM trades t
WHERE p.trade_id = t.id
  AND t.outcome = 'ACTIVE'
  AND t.management_policy = 'TP1_SCALE_OUT_TP2_BREAKEVEN_V3'
  AND p.state NOT LIKE 'CLOSED%';
