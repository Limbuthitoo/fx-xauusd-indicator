INSERT INTO strategy_sources (
  id, strategy_name, source_type, source_creator, implementation_type,
  market_originally_observed, adapted_market, distribution, status, metadata
)
VALUES (
  '00000000-0000-0000-0000-000000000201',
  'New York XAUUSD ORB MAX',
  'USER_SPECIFICATION',
  'Internal Module 1',
  'RULE_BASED_IMPLEMENTATION',
  'XAUUSD New York session',
  'XAUUSD',
  'PLATFORM_MODULE',
  'ACTIVE',
  '{"moduleCode":"orb_max_options","runtime":"NEW_YORK_SESSION","sessionPresets":["NEW_YORK_ORB"],"disclaimer":"Backtest required before real-money use."}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  strategy_name = EXCLUDED.strategy_name,
  metadata = EXCLUDED.metadata,
  status = EXCLUDED.status;

INSERT INTO strategies (id, source_id, name, description)
VALUES (
  '00000000-0000-0000-0000-000000000301',
  '00000000-0000-0000-0000-000000000201',
  'New York XAUUSD ORB MAX',
  'Module 1 ORB strategy for the New York session opening range with 5-minute confirmation triggers and NY-only horizontal range observation.'
)
ON CONFLICT (id) DO UPDATE SET
  source_id = EXCLUDED.source_id,
  name = EXCLUDED.name,
  description = EXCLUDED.description;

INSERT INTO strategy_versions (
  id, strategy_id, version, status, session_start, trade_window_end,
  opening_range_minutes, signal_timeframe_minutes, configuration_json, activated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000401',
  '00000000-0000-0000-0000-000000000301',
  '1.0.0',
  'ACTIVE',
  '09:30',
  '16:00',
  15,
  5,
  '{
    "moduleCode":"orb_max_options",
    "name":"New York XAUUSD ORB MAX",
    "version":"1.0.0",
    "runtime":"NEW_YORK_SESSION",
    "timezone":"America/New_York",
    "symbol":"XAUUSD",
    "sessionPresets":["NEW_YORK_ORB"],
    "openingRangeMinutes":15,
    "signalTimeframeMinutes":5,
    "triggerTimeframeMinutes":5,
    "enableNewsFilter":true,
    "breakout":{
      "requireCompletedCandle":true,
      "requireCloseOutside":true,
      "allowWickOnly":false,
      "minimumBodyRatio":0.45,
      "minimumCloseLocationRatio":0.60,
      "maximumEntryExtensionPercentOfRange":0.25
    },
    "retest":{
      "enabled":true,
      "zonePercentOfRange":0.10,
      "maximumCandles":4,
      "confirmationRequired":true
    },
    "risk":{
      "riskPerTradePercent":0.50,
      "maximumDailyLossPercent":2.00,
      "maximumWeeklyLossPercent":5.00,
      "maximumTradesPerSession":1,
      "mandatoryStopLoss":true,
      "minimumRewardToRisk":2.00,
      "allowMartingale":false,
      "allowAddingToLoss":false
    },
    "favorability":{
      "minimumScoreForPaperTrade":70,
      "preferredSpreadPercentOfRange":0.12,
      "minimumAtrPercentOfRange":0.40
    },
    "newsFilter":{
      "enabled":true,
      "mode":"BLOCK_HIGH_IMPACT",
      "blockMinutesBefore":15,
      "blockMinutesAfter":15
    },
    "paperTrading":{"enabled":true,"maximumTradesPerSession":1,"conservativeSameCandleExit":true}
    ,
    "rangeEngine":{
      "enabled":true,
      "detectorVersion":"GENERIC_RANGE_ENGINE_V1",
      "authoritativeDetector":"MAX_OPTIONS_ORB",
      "preserveOrbBehavior":true,
      "horizontalRange":{
        "enabled":true,
        "observationOnly":true,
        "scope":"NEW_YORK_SESSION_ONLY",
        "timeframe":"5min",
        "minimumRangeCandles":12,
        "maximumRangeCandles":60,
        "minimumUpperTouches":2,
        "minimumLowerTouches":2,
        "minimumBarsBetweenTouches":2,
        "boundaryReactionCount":3,
        "boundaryToleranceAtr":0.08,
        "minimumContainmentRatio":0.75,
        "maximumEfficiencyRatio":0.35,
        "maximumBoundarySlopeAtrPerBar":0.02,
        "minimumWidthAtr":0.8,
        "maximumWidthAtr":4,
        "minimumMidpointCrosses":2,
        "minimumQualityScore":70,
        "lockAfterValidation":true,
        "expireAfterCandles":60
      }
    }
  }'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  session_start = EXCLUDED.session_start,
  trade_window_end = EXCLUDED.trade_window_end,
  opening_range_minutes = EXCLUDED.opening_range_minutes,
  signal_timeframe_minutes = EXCLUDED.signal_timeframe_minutes,
  configuration_json = EXCLUDED.configuration_json,
  activated_at = now();

INSERT INTO user_preferences (user_id, selected_symbol, selected_session_preset, selected_strategy_version_id, account_currency, timezone)
SELECT u.id, 'XAUUSD', 'NEW_YORK_ORB', '00000000-0000-0000-0000-000000000401', 'USD', 'Asia/Kathmandu'
FROM users u
ON CONFLICT (user_id) DO UPDATE SET
  selected_symbol = COALESCE(user_preferences.selected_symbol, EXCLUDED.selected_symbol),
  selected_session_preset = COALESCE(NULLIF(user_preferences.selected_session_preset, ''), EXCLUDED.selected_session_preset),
  selected_strategy_version_id = COALESCE(user_preferences.selected_strategy_version_id, EXCLUDED.selected_strategy_version_id),
  updated_at = now();

INSERT INTO tenant_module_settings (tenant_id, module_code, key, value, category, description)
SELECT
  t.id,
  'orb_max_options',
  'orb.strategy',
  sv.configuration_json,
  'ORB MAX',
  'Tenant-level New York ORB MAX thresholds, NY-only horizontal observation, and automatic paper-trade rules.'
FROM platform_tenants t
JOIN tenant_modules tm ON tm.tenant_id = t.id AND tm.status = 'ENABLED'
JOIN platform_strategy_modules m ON m.id = tm.module_id AND m.code = 'orb_max_options'
CROSS JOIN strategy_versions sv
WHERE sv.id = '00000000-0000-0000-0000-000000000401'
ON CONFLICT (tenant_id, module_code, key) DO UPDATE SET
  value = EXCLUDED.value,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  updated_at = now();

INSERT INTO tenant_automation_states (tenant_id, module_code, enabled, phase, symbol, timeframe_minutes, latest_reason)
SELECT t.id, 'orb_max_options', true, 'STARTING', 'XAUUSD', 5, 'Module 1 New York ORB automation and horizontal range observation are ready.'
FROM platform_tenants t
JOIN tenant_modules tm ON tm.tenant_id = t.id AND tm.status = 'ENABLED'
JOIN platform_strategy_modules m ON m.id = tm.module_id AND m.code = 'orb_max_options'
ON CONFLICT (tenant_id, module_code) DO UPDATE SET
  enabled = true,
  symbol = 'XAUUSD',
  timeframe_minutes = 5,
  latest_reason = EXCLUDED.latest_reason,
  updated_at = now();
