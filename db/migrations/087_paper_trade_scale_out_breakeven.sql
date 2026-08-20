ALTER TABLE paper_trade_targets
  ADD COLUMN IF NOT EXISTS position_fraction NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS realized_r NUMERIC(12,6);

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS realized_r NUMERIC(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_fraction NUMERIC(9,6) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS breakeven_activated_at TIMESTAMPTZ;

UPDATE paper_trade_targets
SET position_fraction = CASE target_number
      WHEN 1 THEN 0.333333
      WHEN 2 THEN 0.333333
      ELSE 0.333334
    END,
    realized_r = CASE
      WHEN status = 'HIT' THEN risk_multiple * CASE target_number
        WHEN 1 THEN 0.333333
        WHEN 2 THEN 0.333333
        ELSE 0.333334
      END
      ELSE NULL
    END,
    updated_at = now()
WHERE position_fraction IS NULL
   OR realized_r IS DISTINCT FROM CASE
     WHEN status = 'HIT' THEN risk_multiple * CASE target_number
       WHEN 1 THEN 0.333333
       WHEN 2 THEN 0.333333
       ELSE 0.333334
     END
     ELSE NULL
   END;

ALTER TABLE paper_trade_targets
  ALTER COLUMN position_fraction SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_trade_targets_position_fraction_check') THEN
    ALTER TABLE paper_trade_targets
      ADD CONSTRAINT paper_trade_targets_position_fraction_check
      CHECK (position_fraction > 0 AND position_fraction <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trades_remaining_fraction_check') THEN
    ALTER TABLE trades
      ADD CONSTRAINT trades_remaining_fraction_check
      CHECK (remaining_fraction >= 0 AND remaining_fraction <= 1);
  END IF;
END $$;

WITH target_state AS (
  SELECT
    trade_id,
    COALESCE(sum(position_fraction) FILTER (WHERE status = 'HIT'), 0) AS hit_fraction,
    COALESCE(sum(realized_r) FILTER (WHERE status = 'HIT'), 0) AS locked_r,
    min(hit_at) FILTER (WHERE target_number = 1 AND status = 'HIT') AS tp1_hit_at
  FROM paper_trade_targets
  GROUP BY trade_id
)
UPDATE trades t
SET realized_r = target_state.locked_r,
    remaining_fraction = CASE
      WHEN t.outcome = 'ACTIVE' THEN greatest(0, 1 - target_state.hit_fraction)
      ELSE 0
    END,
    breakeven_activated_at = COALESCE(t.breakeven_activated_at, target_state.tp1_hit_at),
    actual_stop = CASE
      WHEN target_state.tp1_hit_at IS NOT NULL THEN t.actual_entry
      ELSE t.actual_stop
    END
FROM target_state
WHERE target_state.trade_id = t.id;

INSERT INTO trade_events (trade_id, event_type, payload)
SELECT
  t.id,
  'PAPER_BREAKEVEN_POLICY_BACKFILL',
  jsonb_build_object(
    'mode', 'PAPER',
    'policy', 'EQUAL_THIRDS_TP1_BREAKEVEN',
    'previousOutcome', t.outcome,
    'previousResultR', t.result_r,
    'previousExit', t.actual_exit,
    'breakevenStop', t.actual_entry
  )
FROM trades t
WHERE t.outcome <> 'ACTIVE'
  AND EXISTS (
    SELECT 1 FROM paper_trade_targets ptt
    WHERE ptt.trade_id = t.id AND ptt.target_number = 1 AND ptt.status = 'HIT'
  )
  AND EXISTS (
    SELECT 1 FROM trade_events te
    WHERE te.trade_id = t.id AND te.event_type = 'PAPER_SL_HIT'
  )
  AND NOT EXISTS (
    SELECT 1 FROM trade_events existing
    WHERE existing.trade_id = t.id AND existing.event_type = 'PAPER_BREAKEVEN_POLICY_BACKFILL'
  );

WITH target_state AS (
  SELECT
    t.id AS trade_id,
    t.outcome,
    t.actual_entry::numeric AS entry,
    t.actual_exit::numeric AS prior_exit,
    COALESCE(t.structural_stop, t.actual_stop)::numeric AS structural_stop,
    CASE WHEN sc.direction = 'SHORT' THEN -1::numeric ELSE 1::numeric END AS direction_multiplier,
    COALESCE(sum(ptt.position_fraction) FILTER (WHERE ptt.status = 'HIT'), 0) AS hit_fraction,
    COALESCE(sum(ptt.realized_r) FILTER (WHERE ptt.status = 'HIT'), 0) AS locked_r,
    bool_or(ptt.target_number = 1 AND ptt.status = 'HIT') AS tp1_hit,
    bool_or(ptt.target_number = 3 AND ptt.status = 'HIT') AS tp3_hit,
    EXISTS (
      SELECT 1 FROM trade_events te
      WHERE te.trade_id = t.id AND te.event_type = 'PAPER_SL_HIT'
    ) AS stopped
  FROM trades t
  JOIN trade_plans tp ON tp.id = t.trade_plan_id
  JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
  JOIN paper_trade_targets ptt ON ptt.trade_id = t.id
  WHERE t.outcome <> 'ACTIVE'
  GROUP BY t.id, t.outcome, t.actual_entry, t.actual_exit, t.structural_stop, t.actual_stop, sc.direction
), recalculated AS (
  SELECT *,
    CASE
      WHEN tp3_hit THEN locked_r
      WHEN tp1_hit AND stopped THEN locked_r
      WHEN prior_exit IS NOT NULL AND abs(entry - structural_stop) > 0 THEN
        locked_r + greatest(0, 1 - hit_fraction) * ((prior_exit - entry) * direction_multiplier / abs(entry - structural_stop))
      ELSE locked_r
    END AS weighted_result_r
  FROM target_state
)
UPDATE trades t
SET actual_exit = CASE WHEN recalculated.tp1_hit AND recalculated.stopped THEN recalculated.entry ELSE t.actual_exit END,
    result_r = round(recalculated.weighted_result_r, 4),
    outcome = CASE
      WHEN recalculated.weighted_result_r > 0.00005 THEN 'WIN'
      WHEN recalculated.weighted_result_r < -0.00005 THEN 'LOSS'
      ELSE 'BREAKEVEN'
    END,
    realized_r = recalculated.locked_r,
    remaining_fraction = 0
FROM recalculated
WHERE recalculated.trade_id = t.id;

CREATE INDEX IF NOT EXISTS trades_breakeven_active_idx
  ON trades (breakeven_activated_at DESC)
  WHERE outcome = 'ACTIVE' AND breakeven_activated_at IS NOT NULL;

COMMENT ON COLUMN paper_trade_targets.position_fraction IS
  'Fraction of the original paper position realized at this target; defaults to an equal-third scale-out ladder.';

COMMENT ON COLUMN paper_trade_targets.realized_r IS
  'Immutable weighted R contribution recorded when this target is hit.';

COMMENT ON COLUMN trades.realized_r IS
  'R already locked by filled paper targets, excluding the remaining runner.';

COMMENT ON COLUMN trades.remaining_fraction IS
  'Fraction of the original paper position still open; zero after final settlement.';

COMMENT ON COLUMN trades.breakeven_activated_at IS
  'Time the managed stop moved from structural risk to entry after TP1.';
