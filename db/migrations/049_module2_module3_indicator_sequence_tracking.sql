UPDATE strategy_versions
SET configuration_json = jsonb_set(configuration_json, '{maximumSweepLookbackBars}', '96'::jsonb, true)
WHERE configuration_json->>'moduleCode' = 'high_probability_strategy_2';

UPDATE tenant_module_settings
SET value = jsonb_set(value, '{maximumSweepLookbackBars}', '96'::jsonb, true)
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';
