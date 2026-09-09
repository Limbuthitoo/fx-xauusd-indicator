INSERT INTO notifications (
  tenant_id, event_key, event_type, title, body, priority, data, created_at
)
SELECT
  setup.tenant_id,
  'paper-tp' || target.target_number || '-' || event.trade_id,
  event.event_type,
  'Paper trade TP' || target.target_number || ' reached',
  concat(
    CASE WHEN setup.direction = 'SHORT' THEN 'SELL' ELSE 'BUY' END,
    ' ', setup.symbol, ' booked ', round(target.position_fraction * 100),
    '% at TP', target.target_number, ' (', target.risk_multiple, 'R). ',
    CASE
      WHEN target.target_number = 3 THEN 'The final runner is complete.'
      WHEN trade.management_policy = 'TP1_STRUCTURAL_TP2_BREAKEVEN_V3' AND target.target_number = 1
        THEN 'TP1 is booked. The runner keeps its structural stop until TP2.'
      WHEN trade.management_policy = 'TP1_BUFFERED_TP2_BREAKEVEN_V2' AND target.target_number = 1
        THEN 'The runner has a 0.25R retest buffer; true breakeven activates after TP2.'
      WHEN target.target_number = 1
        THEN 'The remaining runner is protected at exact breakeven.'
      ELSE 'The TP3 runner is protected at breakeven.'
    END
  ),
  'HIGH',
  jsonb_strip_nulls(jsonb_build_object(
    'moduleCode', setup.module_code,
    'tradeId', trade.id,
    'setupId', setup.id,
    'symbol', setup.symbol,
    'direction', setup.direction,
    'action', CASE WHEN setup.direction = 'SHORT' THEN 'SELL' ELSE 'BUY' END,
    'entry', trade.actual_entry,
    'stopLoss', trade.actual_stop,
    'takeProfit', trade.actual_target,
    'targetNumber', target.target_number,
    'targetPrice', target.price,
    'riskMultiple', target.risk_multiple,
    'positionFraction', target.position_fraction,
    'realizedR', target.realized_r,
    'managementPolicy', trade.management_policy,
    'eventKey', 'paper-tp' || target.target_number || '-' || event.trade_id,
    'eventType', event.event_type,
    'backfilled', true,
    'repair', 'MISSING_TARGET_NOTIFICATION_V2'
  )),
  event.created_at
FROM trade_events event
JOIN trades trade ON trade.id = event.trade_id
JOIN trade_plans plan ON plan.id = trade.trade_plan_id
JOIN setup_candidates setup ON setup.id = plan.setup_candidate_id
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

