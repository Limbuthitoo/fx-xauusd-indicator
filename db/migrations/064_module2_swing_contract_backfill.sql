UPDATE strategy_versions
SET
  configuration_json = COALESCE(configuration_json, '{}'::jsonb)
    || '{
      "minimumSwingProminenceATR": 0.2,
      "minimumBarsBetweenSwings": 3,
      "structureToleranceATR": 0.03
    }'::jsonb
WHERE strategy_id = '00000000-0000-0000-0000-000000000302';

UPDATE tenant_module_settings
SET
  value = COALESCE(value, '{}'::jsonb)
    || '{
      "minimumSwingProminenceATR": 0.2,
      "minimumBarsBetweenSwings": 3,
      "structureToleranceATR": 0.03
    }'::jsonb,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';
