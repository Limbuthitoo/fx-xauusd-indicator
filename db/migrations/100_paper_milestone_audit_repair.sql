ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE positions
SET updated_at = COALESCE(closed_at, opened_at, created_at, now());

INSERT INTO trade_events (trade_id, event_type, payload, created_at)
SELECT
  target.trade_id,
  'PAPER_TP' || target.target_number || '_HIT',
  jsonb_build_object(
    'mode', 'PAPER',
    'targetNumber', target.target_number,
    'targetPrice', target.price,
    'riskMultiple', target.risk_multiple,
    'positionFraction', target.position_fraction,
    'realizedR', target.realized_r,
    'candleTimestamp', target.hit_at,
    'backfilled', true,
    'repair', 'MISSING_MILESTONE_EVENT'
  ),
  COALESCE(target.hit_at, target.updated_at, now())
FROM paper_trade_targets target
WHERE target.status = 'HIT'
  AND NOT EXISTS (
    SELECT 1
    FROM trade_events event
    WHERE event.trade_id = target.trade_id
      AND event.event_type = 'PAPER_TP' || target.target_number || '_HIT'
  )
ON CONFLICT (trade_id, event_type)
WHERE event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT', 'PAPER_SL_HIT')
DO NOTHING;

INSERT INTO trade_events (trade_id, event_type, payload, created_at)
SELECT
  target.trade_id,
  'PAPER_STOP_TO_BREAKEVEN',
  jsonb_build_object(
    'mode', 'PAPER',
    'trigger', 'TP1_HIT',
    'backfilled', true,
    'repair', 'MISSING_BREAKEVEN_EVENT'
  ),
  COALESCE(target.hit_at, target.updated_at, now())
FROM paper_trade_targets target
WHERE target.target_number = 1
  AND target.status = 'HIT'
  AND NOT EXISTS (
    SELECT 1
    FROM trade_events event
    WHERE event.trade_id = target.trade_id
      AND event.event_type = 'PAPER_STOP_TO_BREAKEVEN'
  );

COMMENT ON COLUMN positions.updated_at IS
  'Timestamp of the latest paper-position state or stop-management update.';
