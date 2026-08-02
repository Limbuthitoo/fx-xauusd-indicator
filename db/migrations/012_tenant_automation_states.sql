CREATE TABLE IF NOT EXISTS tenant_automation_states (
  tenant_id UUID PRIMARY KEY REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE DEFAULT 'orb_max_options',
  enabled BOOLEAN NOT NULL DEFAULT true,
  running BOOLEAN NOT NULL DEFAULT false,
  phase TEXT NOT NULL DEFAULT 'STARTING',
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  timeframe_minutes INTEGER NOT NULL DEFAULT 5,
  provider TEXT NOT NULL DEFAULT 'TWELVE_DATA',
  latest_candle_at TIMESTAMPTZ,
  latest_setup_id UUID REFERENCES setup_candidates(id) ON DELETE SET NULL,
  latest_trade_id UUID REFERENCES trades(id) ON DELETE SET NULL,
  latest_error TEXT,
  latest_reason TEXT,
  session_id UUID REFERENCES trading_sessions(id) ON DELETE SET NULL,
  session_state TEXT,
  session_start_at TIMESTAMPTZ,
  opening_range_end_at TIMESTAMPTZ,
  signal_window_end_at TIMESTAMPTZ,
  api_start_at TIMESTAMPTZ,
  api_stop_at TIMESTAMPTZ,
  next_action_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_action_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenant_automation_states (tenant_id, module_code, enabled, phase, symbol, timeframe_minutes, latest_reason)
SELECT t.id, 'orb_max_options', true, 'STARTING', 'XAUUSD', 5, 'Tenant automation is ready.'
FROM platform_tenants t
JOIN tenant_modules tm ON tm.tenant_id = t.id AND tm.status = 'ENABLED'
JOIN platform_strategy_modules m ON m.id = tm.module_id AND m.code = 'orb_max_options'
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS tenant_automation_states_phase_idx ON tenant_automation_states(phase);
CREATE INDEX IF NOT EXISTS tenant_automation_states_updated_idx ON tenant_automation_states(updated_at DESC);
