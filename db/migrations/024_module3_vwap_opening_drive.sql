UPDATE platform_strategy_modules
SET
  name = 'Module 3: NY VWAP Opening Drive Pullback',
  description = 'Automated XAUUSD New York opening-drive continuation strategy using VWAP alignment, impulse strength, pullback zone, confirmation candle, paper trading, reports, and backtests.',
  target_win_rate = 'Research target 55-65% after backtest validation',
  updated_at = now()
WHERE code = 'strategy_lab_3';

INSERT INTO strategy_sources (
  id, strategy_name, source_type, source_creator, implementation_type,
  market_originally_observed, adapted_market, distribution, status, metadata
)
VALUES (
  '00000000-0000-0000-0000-000000000203',
  'NY VWAP Opening Drive Pullback',
  'USER_SPECIFICATION',
  'Internal Module 3',
  'RULE_BASED_IMPLEMENTATION',
  'XAUUSD New York session',
  'XAUUSD',
  'PLATFORM_MODULE',
  'RESEARCH',
  '{"moduleCode":"strategy_lab_3","disclaimer":"Backtest required before real-money use."}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  strategy_name = EXCLUDED.strategy_name,
  metadata = EXCLUDED.metadata,
  status = EXCLUDED.status;

INSERT INTO strategies (id, source_id, name, description)
VALUES (
  '00000000-0000-0000-0000-000000000303',
  '00000000-0000-0000-0000-000000000203',
  'NY VWAP Opening Drive Pullback',
  'Module 3 strategy for XAUUSD New York opening-drive impulse, VWAP alignment, pullback, and confirmation-candle entries.'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

INSERT INTO strategy_versions (
  id, strategy_id, version, status, session_start, trade_window_end,
  opening_range_minutes, signal_timeframe_minutes, configuration_json, activated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000403',
  '00000000-0000-0000-0000-000000000303',
  '0.1.0',
  'ACTIVE',
  '09:30',
  '16:00',
  0,
  5,
  '{
    "moduleCode":"strategy_lab_3",
    "name":"NY VWAP Opening Drive Pullback",
    "version":"0.1.0",
    "status":"RESEARCH",
    "symbol":"XAUUSD",
    "timezone":"America/New_York",
    "newYorkStartTime":"09:30",
    "newYorkEndTime":"16:00",
    "setupTimeframe":5,
    "biasTimeframe":15,
    "maximumTradesPerSession":1,
    "openingDriveMinutes":30,
    "minimumDriveRangeATR":1.0,
    "minimumDriveBodyPercent":0.55,
    "minimumVwapDistanceATR":0.05,
    "pullbackMaxBars":12,
    "pullbackZoneAtr":0.35,
    "confirmationBodyPercent":0.45,
    "emaPeriod":20,
    "minimumRiskReward":2.0,
    "maximumStopATR":1.35,
    "stopBufferATR":0.12,
    "maximumSpread":0.80,
    "enableNewsFilter":true,
    "minimumSignalScore":80,
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
  'strategy_lab_3',
  'vwapOpeningDrive.strategy',
  sv.configuration_json,
  'VWAP Opening Drive',
  'User-account Module 3 thresholds for XAUUSD New York VWAP opening-drive pullback paper-trade automation.'
FROM platform_tenants t
CROSS JOIN strategy_versions sv
JOIN strategies s ON s.id = sv.strategy_id
WHERE s.id = '00000000-0000-0000-0000-000000000303'
ON CONFLICT (tenant_id, module_code, key) DO NOTHING;

INSERT INTO tenant_modules (tenant_id, module_id, status)
SELECT t.id, m.id, 'ENABLED'
FROM platform_tenants t
JOIN platform_strategy_modules m ON m.code = 'strategy_lab_3'
WHERE t.slug = 'default-orb-tenant'
ON CONFLICT (tenant_id, module_id) DO UPDATE SET status = 'ENABLED';

INSERT INTO tenant_automation_states (tenant_id, module_code, enabled, phase, symbol, timeframe_minutes, latest_reason)
SELECT t.id, 'strategy_lab_3', true, 'STARTING', 'XAUUSD', 5, 'Module 3 automation is ready.'
FROM platform_tenants t
JOIN tenant_modules tm ON tm.tenant_id = t.id AND tm.status = 'ENABLED'
JOIN platform_strategy_modules m ON m.id = tm.module_id AND m.code = 'strategy_lab_3'
ON CONFLICT (tenant_id, module_code) DO NOTHING;
