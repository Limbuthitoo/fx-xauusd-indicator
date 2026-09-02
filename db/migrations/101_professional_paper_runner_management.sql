ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS management_policy TEXT,
  ADD COLUMN IF NOT EXISTS runner_protection_activated_at TIMESTAMPTZ;

UPDATE trades
SET management_policy = 'EQUAL_THIRDS_TP1_BREAKEVEN_V1'
WHERE management_policy IS NULL;

ALTER TABLE trades
  ALTER COLUMN management_policy SET DEFAULT 'TP1_BUFFERED_TP2_BREAKEVEN_V2',
  ALTER COLUMN management_policy SET NOT NULL;

COMMENT ON COLUMN trades.management_policy IS
  'Immutable paper runner policy. V2 protects at -0.25R after TP1 and reaches true breakeven after TP2.';

COMMENT ON COLUMN trades.runner_protection_activated_at IS
  'Time the runner first received a tighter managed stop after partial profit.';
