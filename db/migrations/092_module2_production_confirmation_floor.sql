UPDATE strategy_versions
SET configuration_json = jsonb_set(
      COALESCE(configuration_json, '{}'::jsonb),
      '{minimumProductionConfirmations}',
      '2'::jsonb,
      true
    ),
    activated_at = now()
WHERE status = 'ACTIVE'
  AND configuration_json->>'moduleCode' = 'high_probability_strategy_2';

UPDATE tenant_module_settings
SET value = jsonb_set(
      COALESCE(value, '{}'::jsonb),
      '{minimumProductionConfirmations}',
      '2'::jsonb,
      true
    ),
    description = 'Module 2 production signals require an E/F/I profile, directional retest candle, and at least two independent confirmations.',
    updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';
