UPDATE strategy_versions
SET configuration_json = jsonb_set(
      COALESCE(configuration_json, '{}'::jsonb),
      '{minimumStopATR}',
      '1'::jsonb,
      true
    ),
    activated_at = now()
WHERE status = 'ACTIVE'
  AND configuration_json->>'moduleCode' = 'high_probability_strategy_2';

UPDATE tenant_module_settings
SET value = jsonb_set(
      COALESCE(value, '{}'::jsonb),
      '{minimumStopATR}',
      '1'::jsonb,
      true
    ),
    description = 'Module 2 liquidity sweep strategy with structural, volatility-normalized 1.0-1.25 ATR stops.',
    updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';
