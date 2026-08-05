UPDATE module2_strategy_variants
SET
  category = 'RESEARCH',
  approval_status = 'RESEARCH_ONLY',
  paper_eligible = false,
  description = 'Research evidence only. This profile can help backtesting and learning, but it must not open live paper trades.',
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2';

UPDATE module2_strategy_variants
SET
  category = 'PRODUCTION',
  approval_status = 'PRODUCTION_APPROVED',
  paper_eligible = true,
  description = 'Strict production path: liquidity sweep, close-back rejection, reversal MSS, MSS retest, entry confirmation candle, risk approval, and confidence threshold.',
  required_rules = '[
    "NY_SESSION_ACTIVE",
    "DAILY_TRADE_LIMIT",
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
    "RISK_OK",
    "SIGNAL_SCORE"
  ]'::jsonb,
  sort_order = 10,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_MSS_RETEST';

UPDATE platform_strategy_modules
SET
  name = 'Module 2: Liquidity Sweep + MSS + Retest',
  description = 'Strict XAUUSD liquidity-sweep engine using close-back rejection, reversal MSS, protected-structure retest, risk validation, paper trading, alerts, and reports.',
  updated_at = now()
WHERE code = 'high_probability_strategy_2';

UPDATE strategy_versions
SET
  configuration_json = COALESCE(configuration_json, '{}'::jsonb)
    || '{
      "newYorkEndTime": "11:30",
      "maximumTradesPerSession": 1,
      "minimumSweepRejectionWickRatio": 0.25,
      "minimumBosCloseDistanceATR": 0.03,
      "maximumBarsAfterBosForEntry": 6,
      "minimumRiskReward": 1.5,
      "minimumSignalScore": 80,
      "emaFilterMode": "WARN_ONLY",
      "volumeFilterMode": "RECORD_ONLY"
    }'::jsonb
WHERE strategy_id = '00000000-0000-0000-0000-000000000302';
