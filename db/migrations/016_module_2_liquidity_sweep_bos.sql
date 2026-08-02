ALTER TABLE trading_sessions
  ADD COLUMN IF NOT EXISTS module_code TEXT REFERENCES platform_strategy_modules(code) ON DELETE SET NULL DEFAULT 'orb_max_options';

ALTER TABLE setup_candidates
  ADD COLUMN IF NOT EXISTS module_code TEXT REFERENCES platform_strategy_modules(code) ON DELETE SET NULL DEFAULT 'orb_max_options';

ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS module_code TEXT REFERENCES platform_strategy_modules(code) ON DELETE SET NULL DEFAULT 'orb_max_options';

UPDATE trading_sessions SET module_code = 'orb_max_options' WHERE module_code IS NULL;
UPDATE setup_candidates SET module_code = 'orb_max_options' WHERE module_code IS NULL;
UPDATE backtest_runs SET module_code = 'orb_max_options' WHERE module_code IS NULL;

ALTER TABLE tenant_automation_states
  DROP CONSTRAINT IF EXISTS tenant_automation_states_pkey;

ALTER TABLE tenant_automation_states
  ADD CONSTRAINT tenant_automation_states_pkey PRIMARY KEY (tenant_id, module_code);

UPDATE platform_strategy_modules
SET
  name = 'Module 2: NY Liquidity Sweep + BOS',
  description = 'Automated XAUUSD New York liquidity sweep, displacement, BOS/CHoCH, FVG/order-block, paper trading, checklist, alerts, and reports.',
  target_win_rate = 'Research pending, backtest required',
  updated_at = now()
WHERE code = 'high_probability_strategy_2';

INSERT INTO strategy_sources (
  id, strategy_name, source_type, source_creator, implementation_type,
  market_originally_observed, adapted_market, distribution, status, metadata
)
VALUES (
  '00000000-0000-0000-0000-000000000202',
  'New York Liquidity Sweep + BOS',
  'USER_SPECIFICATION',
  'Internal Module 2',
  'RULE_BASED_IMPLEMENTATION',
  'XAUUSD New York session',
  'XAUUSD',
  'PLATFORM_MODULE',
  'RESEARCH',
  '{"moduleCode":"high_probability_strategy_2","disclaimer":"Backtest required before real-money use."}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  strategy_name = EXCLUDED.strategy_name,
  metadata = EXCLUDED.metadata,
  status = EXCLUDED.status;

INSERT INTO strategies (id, source_id, name, description)
VALUES (
  '00000000-0000-0000-0000-000000000302',
  '00000000-0000-0000-0000-000000000202',
  'NY Liquidity Sweep + BOS',
  'Module 2 strategy for XAUUSD New York liquidity sweeps, displacement, BOS/CHoCH, and FVG/order-block retracement entries.'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

INSERT INTO strategy_versions (
  id, strategy_id, version, status, session_start, trade_window_end,
  opening_range_minutes, signal_timeframe_minutes, configuration_json, activated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000402',
  '00000000-0000-0000-0000-000000000302',
  '0.1.0',
  'ACTIVE',
  '09:30',
  '16:00',
  0,
  5,
  '{
    "moduleCode":"high_probability_strategy_2",
    "name":"NY Liquidity Sweep + BOS",
    "version":"0.1.0",
    "status":"RESEARCH",
    "symbol":"XAUUSD",
    "timezone":"America/New_York",
    "newYorkStartTime":"09:30",
    "newYorkEndTime":"16:00",
    "biasTimeframe":15,
    "setupTimeframe":5,
    "entryTimeframe":5,
    "maximumTradesPerSession":1,
    "minimumSweepDistanceATR":0.10,
    "maximumSweepDistanceATR":1.00,
    "closeBackMaximumBars":3,
    "minimumDisplacementRangeATR":1.20,
    "minimumBodyPercentage":0.60,
    "maximumBarsAfterSweep":5,
    "pivotLeftBars":2,
    "pivotRightBars":2,
    "minimumBosCloseDistanceATR":0.05,
    "maximumBarsAfterSweepForBos":10,
    "maximumBarsAfterBosForEntry":15,
    "minimumFvgSizeATR":0.10,
    "entryAtFvgPercentage":50,
    "minimumRiskReward":2.0,
    "maximumStopATR":1.25,
    "stopBufferATR":0.10,
    "minimumSignalScore":80,
    "maximumSpread":0.80,
    "enableNewsFilter":true,
    "requireHtfBias":true,
    "paperTrading":{"enabled":true,"maximumTradesPerSession":1,"conservativeSameCandleExit":true}
  }'::jsonb,
  now()
)
ON CONFLICT (strategy_id, version) DO UPDATE SET
  status = EXCLUDED.status,
  session_start = EXCLUDED.session_start,
  trade_window_end = EXCLUDED.trade_window_end,
  opening_range_minutes = EXCLUDED.opening_range_minutes,
  signal_timeframe_minutes = EXCLUDED.signal_timeframe_minutes,
  configuration_json = EXCLUDED.configuration_json,
  activated_at = now();

INSERT INTO tenant_module_settings (tenant_id, module_code, key, value, category, description)
SELECT
  t.id,
  'high_probability_strategy_2',
  'liquiditySweep.strategy',
  sv.configuration_json,
  'Liquidity Sweep + BOS',
  'User-account Module 2 thresholds for XAUUSD New York liquidity sweep + BOS paper-trade automation.'
FROM platform_tenants t
CROSS JOIN strategy_versions sv
JOIN strategies s ON s.id = sv.strategy_id
WHERE s.id = '00000000-0000-0000-0000-000000000302'
ON CONFLICT (tenant_id, module_code, key) DO NOTHING;

INSERT INTO tenant_automation_states (tenant_id, module_code, enabled, phase, symbol, timeframe_minutes, latest_reason)
SELECT t.id, 'high_probability_strategy_2', true, 'STARTING', 'XAUUSD', 5, 'Module 2 automation is ready.'
FROM platform_tenants t
JOIN tenant_modules tm ON tm.tenant_id = t.id AND tm.status = 'ENABLED'
JOIN platform_strategy_modules m ON m.id = tm.module_id AND m.code = 'high_probability_strategy_2'
ON CONFLICT (tenant_id, module_code) DO NOTHING;

CREATE INDEX IF NOT EXISTS trading_sessions_module_idx ON trading_sessions(tenant_id, module_code, session_date);
CREATE INDEX IF NOT EXISTS setup_candidates_module_idx ON setup_candidates(tenant_id, module_code, detected_at DESC);
CREATE INDEX IF NOT EXISTS backtest_runs_module_idx ON backtest_runs(tenant_id, module_code, started_at DESC);
