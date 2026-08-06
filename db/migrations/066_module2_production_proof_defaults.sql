INSERT INTO tenant_module_settings (tenant_id, module_code, key, value, category, description)
SELECT
  tm.tenant_id,
  'high_probability_strategy_2',
  'liquiditySweep.strategy',
  COALESCE(sv.configuration_json, '{}'::jsonb)
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
      "liquidityReusePolicy": "ONCE_PER_LEVEL_PER_SESSION",
      "liquidityMergeToleranceATR": 0.08,
      "maximumSwingLevelAgeDays": 5,
      "countertrendResolutionMode": "BLOCK_STRONG_CONFLICT",
      "positionManagementMode": "AUTO_PAPER_ONLY",
      "minimumTradesForInsight": 30,
      "minimumSignalScore": 80,
      "minimumRiskReward": 1.5,
      "stopBufferATR": 0.03,
      "maximumBarsAfterBosForEntry": 6
    }'::jsonb,
  'Ultimate Liquidity Sweep',
  'Tenant-level Module 2 production proof and MSS retest strategy settings.'
FROM tenant_modules tm
JOIN platform_strategy_modules m ON m.id = tm.module_id
LEFT JOIN LATERAL (
  SELECT configuration_json
  FROM strategy_versions
  WHERE strategy_id = '00000000-0000-0000-0000-000000000302'
  ORDER BY activated_at DESC NULLS LAST, created_at DESC
  LIMIT 1
) sv ON true
WHERE m.code = 'high_probability_strategy_2'
  AND tm.status = 'ENABLED'
ON CONFLICT (tenant_id, module_code, key) DO UPDATE SET
  value = COALESCE(tenant_module_settings.value, '{}'::jsonb)
    || EXCLUDED.value,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  updated_at = now();
