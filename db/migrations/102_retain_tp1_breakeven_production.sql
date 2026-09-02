ALTER TABLE trades
  ALTER COLUMN management_policy SET DEFAULT 'EQUAL_THIRDS_TP1_BREAKEVEN_V1';

COMMENT ON COLUMN trades.management_policy IS
  'Immutable paper runner policy. Production retains V1 exact breakeven after TP1; alternatives remain observation-only until an independent-signal release gate passes.';
