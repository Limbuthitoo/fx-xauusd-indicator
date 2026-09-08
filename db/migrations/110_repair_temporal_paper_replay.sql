CREATE TEMP TABLE invalid_temporal_paper_closures ON COMMIT DROP AS
SELECT DISTINCT trade.id AS trade_id, trade.trade_plan_id
FROM trades trade
JOIN paper_trade_targets tp2
  ON tp2.trade_id = trade.id
 AND tp2.target_number = 2
 AND tp2.status = 'HIT'
JOIN paper_trade_targets tp3
  ON tp3.trade_id = trade.id
 AND tp3.target_number = 3
 AND tp3.status = 'CANCELLED'
JOIN trade_events closed_event
  ON closed_event.trade_id = trade.id
 AND closed_event.event_type = 'PAPER_AUTO_CLOSE'
WHERE trade.management_policy = 'TP1_SCALE_OUT_TP2_BREAKEVEN_V3'
  AND trade.outcome = 'WIN'
  AND trade.actual_exit = trade.actual_entry
  AND trade.closed_at < tp2.hit_at
  AND closed_event.payload->>'exitReason' = 'BREAKEVEN_STOP';

UPDATE trades trade
SET actual_exit = NULL,
    result_r = NULL,
    outcome = 'ACTIVE',
    closed_at = NULL,
    close_reason = NULL,
    remaining_fraction = target_state.remaining_fraction,
    excursion_updated_at = target_state.last_hit_at
FROM (
  SELECT invalid.trade_id,
         greatest(0, 1 - sum(target.position_fraction) FILTER (WHERE target.status = 'HIT')) AS remaining_fraction,
         max(target.hit_at) FILTER (WHERE target.status = 'HIT') AS last_hit_at
  FROM invalid_temporal_paper_closures invalid
  JOIN paper_trade_targets target ON target.trade_id = invalid.trade_id
  GROUP BY invalid.trade_id
) target_state
WHERE trade.id = target_state.trade_id;

UPDATE paper_trade_targets target
SET status = 'PENDING',
    hit_at = NULL,
    hit_price = NULL,
    realized_r = NULL,
    metadata = (target.metadata - 'cancelReason') || '{"temporalReplayRepair":"MIGRATION_110"}'::jsonb,
    updated_at = now()
FROM invalid_temporal_paper_closures invalid
WHERE target.trade_id = invalid.trade_id
  AND target.target_number = 3
  AND target.status = 'CANCELLED';

UPDATE trade_plans plan
SET status = 'EXECUTED'
FROM invalid_temporal_paper_closures invalid
WHERE plan.id = invalid.trade_plan_id;

DELETE FROM journal_entries journal
USING invalid_temporal_paper_closures invalid
WHERE journal.trade_id = invalid.trade_id
  AND journal.decision = 'PAPER_AUTO_CLOSE';

DELETE FROM trade_events event
USING invalid_temporal_paper_closures invalid
WHERE event.trade_id = invalid.trade_id
  AND event.event_type IN ('PAPER_SL_HIT', 'PAPER_AUTO_CLOSE');

INSERT INTO trade_events (trade_id, event_type, payload)
SELECT invalid.trade_id,
       'PAPER_TEMPORAL_REPLAY_REPAIRED',
       jsonb_build_object(
         'mode', 'PAPER',
         'source', 'MIGRATION_110',
         'reason', 'A later breakeven stop was incorrectly applied to a candle at or before TP2.'
       )
FROM invalid_temporal_paper_closures invalid;

-- The corrected API resumes strictly after the TP2 candle and deterministically
-- applies any later TP3 or genuine breakeven touch from persisted market data.

COMMENT ON COLUMN trades.excursion_updated_at IS
  'Timestamp of the latest candle evaluated for paper lifecycle state; ledger catch-up resumes strictly after this cursor.';
