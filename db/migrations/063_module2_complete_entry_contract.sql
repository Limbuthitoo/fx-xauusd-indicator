UPDATE module2_strategy_variants
SET
  category = 'RESEARCH',
  approval_status = 'RESEARCH_ONLY',
  paper_eligible = false,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2';

UPDATE module2_strategy_variants
SET
  category = 'PRODUCTION',
  approval_status = 'PRODUCTION_APPROVED',
  paper_eligible = true,
  description = 'Complete production contract: healthy data, New York session, ranked liquidity sweep with close-back rejection, reversal MSS, protected-structure retest, entry candle, conflict/risk gates, and confidence threshold.',
  required_rules = '[
    "DATA_HEALTHY",
    "MARKET_CONTEXT_READY",
    "MARKET_REGIME_CLASSIFIED",
    "NY_SESSION_ACTIVE",
    "DAILY_TRADE_LIMIT",
    "ACTIVE_SETUP_CONFLICT_CLEAR",
    "NO_ACTIVE_TRADE_CONFLICT",
    "RISK_LIMITS_CLEAR",
    "MANUAL_CONFIRMATION_COMPLETED",
    "LIQUIDITY_LEVEL_IDENTIFIED",
    "LIQUIDITY_SWEEP_CONFIRMED",
    "SWEEP_REJECTION_CONFIRMED",
    "SWEEP_ACCEPTANCE_BLOCK",
    "PROTECTED_POINT_CONFIDENCE",
    "BOS_CHOCH_CONFIRMED",
    "MSS_STRENGTH",
    "ENTRY_ZONE_READY",
    "ENTRY_ZONE_RETRACE",
    "CONFIRM_ENTRY_CANDLE",
    "DIRECTIONAL_CONFLICT_CLEAR",
    "RISK_OK",
    "SIGNAL_SCORE",
    "VARIANT_SELECTED"
  ]'::jsonb,
  sort_order = 10,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_MSS_RETEST';

UPDATE strategy_versions
SET
  configuration_json = COALESCE(configuration_json, '{}'::jsonb)
    || '{
      "marketContextMode": "RECORD_ONLY",
      "displacementFilterMode": "WARN_ONLY",
      "emaFilterMode": "WARN_ONLY",
      "volumeFilterMode": "RECORD_ONLY",
      "nyPremarketStartTime": "08:00",
      "orbStartTime": "09:30",
      "orbEndTime": "09:45",
      "roundNumberStep": 10,
      "roundNumberWindowSteps": 4,
      "manualLevels": [],
      "manualConfirmationRequired": false,
      "maximumActiveSetupsPerSymbol": 1,
      "maximumActivePositions": 0,
      "riskPerTradePercent": 0.25,
      "maximumDailyLossPercent": 0.75,
      "maximumWeeklyLossPercent": 2.0,
      "maximumConsecutiveLosses": 3,
      "minimumSwingProminenceATR": 0.2,
      "minimumBarsBetweenSwings": 3,
      "structureToleranceATR": 0.03,
      "minimumSignalScore": 80,
      "minimumRiskReward": 1.5,
      "stopBufferATR": 0.03,
      "maximumBarsAfterBosForEntry": 6
    }'::jsonb
WHERE strategy_id = '00000000-0000-0000-0000-000000000302';

UPDATE platform_strategy_modules
SET
  name = 'Module 2: Ultimate Liquidity Sweep + MSS + Retest',
  description = 'Production XAUUSD sweep engine with ranked liquidity, close-back rejection, reversal MSS, retest entry, risk gates, paper trading, alerts, journal, learning, and reports.',
  updated_at = now()
WHERE code = 'high_probability_strategy_2';

UPDATE tenant_module_settings
SET
  value = COALESCE(value, '{}'::jsonb)
    || '{
      "marketContextMode": "RECORD_ONLY",
      "displacementFilterMode": "WARN_ONLY",
      "emaFilterMode": "WARN_ONLY",
      "volumeFilterMode": "RECORD_ONLY",
      "nyPremarketStartTime": "08:00",
      "orbStartTime": "09:30",
      "orbEndTime": "09:45",
      "roundNumberStep": 10,
      "roundNumberWindowSteps": 4,
      "manualLevels": [],
      "manualConfirmationRequired": false,
      "maximumActiveSetupsPerSymbol": 1,
      "maximumActivePositions": 0,
      "riskPerTradePercent": 0.25,
      "maximumDailyLossPercent": 0.75,
      "maximumWeeklyLossPercent": 2.0,
      "maximumConsecutiveLosses": 3,
      "minimumSwingProminenceATR": 0.2,
      "minimumBarsBetweenSwings": 3,
      "structureToleranceATR": 0.03,
      "minimumSweepDistanceATR": 0.02,
      "maximumSweepDistanceATR": 0.5,
      "minimumBosCloseDistanceATR": 0.03,
      "minimumRiskReward": 1.5,
      "stopBufferATR": 0.03,
      "maximumBarsAfterBosForEntry": 6
    }'::jsonb,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';
