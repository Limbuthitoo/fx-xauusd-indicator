INSERT INTO users (id, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Personal Trader')
ON CONFLICT (id) DO NOTHING;

INSERT INTO instruments (symbol, display_name, base_asset, quote_currency, price_decimals, tick_size, pip_definition)
VALUES ('XAUUSD', 'Gold vs US Dollar', 'XAU', 'USD', 2, 0.01, 'BROKER_CONFIGURABLE')
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO broker_specs (
  id, user_id, symbol, contract_size, minimum_lot, lot_step, maximum_lot,
  tick_size, tick_value, account_currency, commission_per_lot, typical_spread
)
VALUES (
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000001',
  'XAUUSD', 100, 0.01, 0.01, 50, 0.01, 1, 'USD', 0, 0.25
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO strategy_sources (
  id, strategy_name, source_type, source_creator, implementation_type,
  market_originally_observed, adapted_market, distribution, status, metadata
)
VALUES (
  '00000000-0000-0000-0000-000000000201',
  'Max-Inspired XAUUSD New York ORB',
  'PUBLIC_EDUCATIONAL_REFERENCE',
  'Max Options Trading',
  'USER_INTERPRETATION',
  'US market ORB concepts',
  'XAUUSD',
  'PERSONAL_USE_ONLY',
  'RESEARCH',
  '{"disclaimer":"Does not reproduce paid or private proprietary strategy exactly."}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO strategies (id, source_id, name, description)
VALUES (
  '00000000-0000-0000-0000-000000000301',
  '00000000-0000-0000-0000-000000000201',
  'Max-Inspired XAUUSD NY ORB',
  'Research strategy for manual New York opening range breakout guidance.'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO strategy_versions (
  id, strategy_id, version, status, session_start, trade_window_end,
  opening_range_minutes, signal_timeframe_minutes, configuration_json, activated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000401',
  '00000000-0000-0000-0000-000000000301',
  '0.1.0',
  'ACTIVE',
  '09:15',
  '16:00',
  15,
  15,
  '{
    "name":"Max-Inspired XAUUSD NY ORB",
    "version":"0.1.0",
    "status":"RESEARCH",
    "symbol":"XAUUSD",
    "timezone":"America/New_York",
    "sessionStart":"09:15",
    "openingRangeMinutes":15,
    "signalTimeframeMinutes":15,
    "tradeWindowEnd":"16:00",
    "enabledScenarios":{
      "cleanBreakout":true,
      "breakoutRetest":true,
      "failedBreakoutReversal":true,
      "midpointReaction":"RECORD_ONLY",
      "doubleSidedSweep":"BLOCK_CONTINUATION",
      "chopDetection":true
    },
    "breakout":{
      "requireCompletedCandle":true,
      "requireCloseOutside":true,
      "allowWickOnly":false,
      "minimumBodyRatio":0.55,
      "minimumCloseLocationRatio":0.65,
      "maximumEntryExtensionPercentOfRange":0.25
    },
    "retest":{"enabled":true,"zonePercentOfRange":0.10,"maximumCandles":6,"confirmationRequired":true},
    "rangeFilter":{"mode":"WARN_ONLY","minimumWidth":null,"maximumWidth":null},
    "trendFilter":{"mode":"RECORD_ONLY"},
    "favorability":{
      "minimumScoreForPaperTrade":70,
      "minimumTrendLookbackCandles":50,
      "preferredSpreadPercentOfRange":0.12,
      "minimumAtrPercentOfRange":0.4
    },
    "newsFilter":{"enabled":true,"mode":"BLOCK","manualEvents":true},
    "risk":{
      "riskPerTradePercent":0.25,
      "maximumDailyLossPercent":0.75,
      "maximumWeeklyLossPercent":2.0,
      "maximumTradesPerSession":1,
      "maximumConsecutiveLosses":3,
      "mandatoryStopLoss":true,
      "minimumRewardToRisk":1.5,
      "allowMartingale":false,
      "allowAddingToLoss":false
    },
    "paperTrading":{"enabled":true,"maximumTradesPerSession":1,"conservativeSameCandleExit":true},
    "execution":{"mode":"PAPER_ONLY","manualConfirmationRequired":false}
  }'::jsonb,
  now()
)
ON CONFLICT (strategy_id, version) DO NOTHING;

INSERT INTO user_preferences (user_id, selected_strategy_version_id)
VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000401')
ON CONFLICT (user_id) DO UPDATE SET selected_strategy_version_id = EXCLUDED.selected_strategy_version_id;

INSERT INTO risk_profiles (id, user_id, name)
VALUES ('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000001', 'Conservative Research Default')
ON CONFLICT (id) DO NOTHING;
