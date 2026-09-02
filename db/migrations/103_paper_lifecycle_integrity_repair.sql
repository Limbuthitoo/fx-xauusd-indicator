UPDATE trades
SET shadow_observation_started_at = NULL,
    shadow_observation_until = NULL,
    shadow_observation_completed_at = NULL,
    shadow_max_favorable_price = NULL,
    shadow_max_adverse_price = NULL,
    shadow_max_favorable_excursion_r = 0,
    shadow_max_adverse_before_tp1_r = 0,
    shadow_tp1_hit_at = NULL,
    shadow_tp2_hit_at = NULL,
    shadow_tp3_hit_at = NULL,
    shadow_recovered_after_stop = false
WHERE shadow_observation_started_at IS NOT NULL
  AND (shadow_observation_until IS NULL
    OR shadow_observation_until < shadow_observation_started_at
    OR (shadow_observation_completed_at IS NOT NULL
      AND shadow_observation_completed_at < shadow_observation_started_at));

UPDATE trades
SET shadow_max_favorable_excursion_r = greatest(0, shadow_max_favorable_excursion_r),
    shadow_max_adverse_before_tp1_r = greatest(0, shadow_max_adverse_before_tp1_r),
    shadow_recovered_after_stop = shadow_tp1_hit_at IS NOT NULL
WHERE shadow_observation_started_at IS NOT NULL
  AND (shadow_max_favorable_excursion_r < 0
    OR shadow_max_adverse_before_tp1_r < 0
    OR (shadow_recovered_after_stop AND shadow_tp1_hit_at IS NULL));

INSERT INTO notifications (
  tenant_id, event_key, event_type, title, body, priority, data, created_at
)
SELECT
  sc.tenant_id,
  'paper-tp' || target.target_number || '-' || event.trade_id,
  event.event_type,
  'Paper trade TP' || target.target_number || ' reached',
  concat(
    CASE WHEN sc.direction = 'SHORT' THEN 'SELL' ELSE 'BUY' END,
    ' ', sc.symbol, ' booked ', round(target.position_fraction * 100),
    '% at TP', target.target_number, ' (', target.risk_multiple, 'R). ',
    CASE
      WHEN target.target_number = 3 THEN 'The final runner is complete.'
      WHEN t.management_policy = 'TP1_BUFFERED_TP2_BREAKEVEN_V2' AND target.target_number = 1
        THEN 'The runner has a 0.25R retest buffer; true breakeven activates after TP2.'
      WHEN t.management_policy = 'TP1_BUFFERED_TP2_BREAKEVEN_V2'
        THEN 'The TP3 runner is protected at breakeven.'
      WHEN target.target_number = 1
        THEN 'The remaining runner is protected at exact breakeven.'
      ELSE 'The TP3 runner remains protected at breakeven.'
    END
  ),
  'HIGH',
  jsonb_strip_nulls(jsonb_build_object(
    'moduleCode', sc.module_code,
    'tradeId', t.id,
    'setupId', sc.id,
    'symbol', sc.symbol,
    'direction', sc.direction,
    'action', CASE WHEN sc.direction = 'SHORT' THEN 'SELL' ELSE 'BUY' END,
    'entry', t.actual_entry,
    'stopLoss', t.actual_stop,
    'takeProfit', t.actual_target,
    'targetNumber', target.target_number,
    'targetPrice', target.price,
    'riskMultiple', target.risk_multiple,
    'positionFraction', target.position_fraction,
    'realizedR', target.realized_r,
    'managementPolicy', t.management_policy,
    'eventKey', 'paper-tp' || target.target_number || '-' || event.trade_id,
    'eventType', event.event_type,
    'backfilled', true,
    'repair', 'MISSING_TARGET_NOTIFICATION'
  )),
  event.created_at
FROM trade_events event
JOIN trades t ON t.id = event.trade_id
JOIN trade_plans plan ON plan.id = t.trade_plan_id
JOIN setup_candidates sc ON sc.id = plan.setup_candidate_id
JOIN paper_trade_targets target
  ON target.trade_id = event.trade_id
 AND event.event_type = 'PAPER_TP' || target.target_number || '_HIT'
WHERE event.event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT')
  AND COALESCE(event.payload->>'backfilled', 'false') <> 'true'
  AND NOT EXISTS (
    SELECT 1
    FROM notifications existing
    WHERE existing.data->>'tradeId' = event.trade_id::text
      AND existing.event_type = event.event_type
  )
ON CONFLICT (event_key) DO UPDATE
SET tenant_id = EXCLUDED.tenant_id,
    event_type = EXCLUDED.event_type,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    priority = EXCLUDED.priority,
    data = notifications.data || EXCLUDED.data;
