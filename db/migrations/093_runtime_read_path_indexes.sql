CREATE INDEX IF NOT EXISTS trades_trade_plan_opened_idx
  ON trades (trade_plan_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS trades_active_trade_plan_idx
  ON trades (trade_plan_id, opened_at DESC)
  WHERE outcome = 'ACTIVE';

CREATE INDEX IF NOT EXISTS trade_events_trade_created_idx
  ON trade_events (trade_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tenant_modules_enabled_lookup_idx
  ON tenant_modules (tenant_id, module_id)
  WHERE status = 'ENABLED';

ANALYZE trades;
ANALYZE trade_events;
ANALYZE tenant_modules;
