UPDATE strategy_versions
SET configuration_json = jsonb_set(
  jsonb_set(configuration_json, '{maximumTradesPerSession}', '3'::jsonb, true),
  '{paperTrading,maximumTradesPerSession}', '3'::jsonb, true
)
WHERE configuration_json->>'moduleCode' = 'high_probability_strategy_2';

UPDATE tenant_module_settings
SET value = jsonb_set(
  jsonb_set(value, '{maximumTradesPerSession}', '3'::jsonb, true),
  '{paperTrading,maximumTradesPerSession}', '3'::jsonb, true
)
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';

UPDATE strategy_versions
SET configuration_json = jsonb_set(
  jsonb_set(configuration_json, '{risk,maximumTradesPerSession}', '3'::jsonb, true),
  '{paperTrading,maximumTradesPerSession}', '3'::jsonb, true
)
WHERE configuration_json->>'moduleCode' = 'orb_max_options'
   OR strategy_id IN (SELECT id FROM strategies WHERE name ILIKE '%ORB%');

UPDATE tenant_module_settings
SET value = jsonb_set(
  jsonb_set(value, '{risk,maximumTradesPerSession}', '3'::jsonb, true),
  '{paperTrading,maximumTradesPerSession}', '3'::jsonb, true
)
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';
