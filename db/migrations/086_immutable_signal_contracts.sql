ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS signal_thesis_key TEXT,
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

UPDATE trade_plans
SET promoted_at = created_at
WHERE promoted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS trade_plans_signal_thesis_unique_idx
  ON trade_plans (signal_thesis_key)
  WHERE signal_thesis_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS trade_plans_signal_history_idx
  ON trade_plans (promoted_at DESC, created_at DESC)
  WHERE signal_thesis_key IS NOT NULL;
