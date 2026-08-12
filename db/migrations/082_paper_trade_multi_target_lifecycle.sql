CREATE TABLE IF NOT EXISTS paper_trade_targets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trade_id UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  target_number SMALLINT NOT NULL CHECK (target_number BETWEEN 1 AND 3),
  price NUMERIC(18,5) NOT NULL,
  risk_multiple NUMERIC(8,4) NOT NULL CHECK (risk_multiple > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'HIT', 'CANCELLED')),
  hit_at TIMESTAMPTZ,
  hit_price NUMERIC(18,5),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trade_id, target_number)
);

CREATE INDEX IF NOT EXISTS paper_trade_targets_trade_status_idx
  ON paper_trade_targets (trade_id, status, target_number);

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS structural_stop NUMERIC(18,5),
  ADD COLUMN IF NOT EXISTS initial_risk_distance NUMERIC(18,5);

UPDATE trades
SET structural_stop = COALESCE(structural_stop, actual_stop),
    initial_risk_distance = COALESCE(initial_risk_distance, abs(actual_entry - actual_stop))
WHERE actual_entry IS NOT NULL
  AND actual_stop IS NOT NULL
  AND (structural_stop IS NULL OR initial_risk_distance IS NULL);

WITH ranked_milestones AS (
  SELECT id,
         row_number() OVER (PARTITION BY trade_id, event_type ORDER BY created_at, id) AS duplicate_rank
  FROM trade_events
  WHERE event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT', 'PAPER_SL_HIT')
)
DELETE FROM trade_events
WHERE id IN (SELECT id FROM ranked_milestones WHERE duplicate_rank > 1);

CREATE UNIQUE INDEX IF NOT EXISTS trade_events_paper_milestone_unique_idx
  ON trade_events (trade_id, event_type)
  WHERE event_type IN ('PAPER_TP1_HIT', 'PAPER_TP2_HIT', 'PAPER_TP3_HIT', 'PAPER_SL_HIT');

WITH geometry AS (
  SELECT
    t.id AS trade_id,
    t.actual_entry::numeric AS entry,
    t.actual_stop::numeric AS stop,
    t.actual_target::numeric AS target,
    t.outcome,
    t.closed_at,
    CASE WHEN sc.direction = 'SHORT' THEN -1::numeric ELSE 1::numeric END AS direction_multiplier,
    abs(t.actual_entry - t.actual_stop)::numeric AS risk_distance,
    abs(t.actual_target - t.actual_entry) / NULLIF(abs(t.actual_entry - t.actual_stop), 0) AS final_r
  FROM trades t
  JOIN trade_plans tp ON tp.id = t.trade_plan_id
  JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
  WHERE t.actual_entry IS NOT NULL
    AND t.actual_stop IS NOT NULL
    AND t.actual_target IS NOT NULL
    AND abs(t.actual_entry - t.actual_stop) > 0
), targets AS (
  SELECT trade_id, target_number, risk_multiple, outcome, closed_at,
    entry + direction_multiplier * risk_distance * risk_multiple AS price
  FROM geometry
  CROSS JOIN LATERAL (VALUES
    (1::smallint, least(1::numeric, final_r)),
    (2::smallint, least(1.5::numeric, final_r)),
    (3::smallint, final_r)
  ) target_plan(target_number, risk_multiple)
  WHERE final_r > 0
)
INSERT INTO paper_trade_targets (trade_id, target_number, price, risk_multiple, status, hit_at, hit_price, metadata)
SELECT
  trade_id,
  target_number,
  round(price, 5),
  round(risk_multiple, 4),
  CASE WHEN outcome = 'ACTIVE' THEN 'PENDING' WHEN outcome = 'WIN' THEN 'HIT' ELSE 'CANCELLED' END,
  CASE WHEN outcome = 'WIN' THEN closed_at ELSE NULL END,
  CASE WHEN outcome = 'WIN' THEN round(price, 5) ELSE NULL END,
  '{"source":"MIGRATION_BACKFILL"}'::jsonb
FROM targets
ON CONFLICT (trade_id, target_number) DO UPDATE SET
  price = EXCLUDED.price,
  risk_multiple = EXCLUDED.risk_multiple,
  status = CASE
    WHEN paper_trade_targets.status = 'PENDING' AND EXCLUDED.status <> 'PENDING' THEN EXCLUDED.status
    ELSE paper_trade_targets.status
  END,
  hit_at = COALESCE(paper_trade_targets.hit_at, EXCLUDED.hit_at),
  hit_price = COALESCE(paper_trade_targets.hit_price, EXCLUDED.hit_price),
  updated_at = now();

COMMENT ON TABLE paper_trade_targets IS
  'Paper-position target milestones. TP1/TP2 are progress evidence; TP3 is the strategy target that closes the paper trade.';

COMMENT ON COLUMN trades.structural_stop IS
  'Immutable stop snapshot used when the paper target ladder was initialized.';

COMMENT ON COLUMN trades.initial_risk_distance IS
  'Absolute entry-to-structural-stop distance used for consistent R calculations.';
