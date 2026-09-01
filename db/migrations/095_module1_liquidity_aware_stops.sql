UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
  jsonb_set(
    COALESCE(sv.configuration_json, '{}'::jsonb),
    '{risk,minimumStopAtr}',
    '2.0'::jsonb,
    true
  ),
  '{risk,liquidityBufferAtr}',
  '0.25'::jsonb,
  true
)
FROM strategies strategy
JOIN strategy_sources source ON source.id = strategy.source_id
WHERE sv.strategy_id = strategy.id
  AND COALESCE(sv.configuration_json->>'moduleCode', source.metadata->>'moduleCode', 'orb_max_options') = 'orb_max_options';

UPDATE tenant_module_settings
SET value = jsonb_set(
  jsonb_set(
    COALESCE(value, '{}'::jsonb),
    '{risk,minimumStopAtr}',
    '2.0'::jsonb,
    true
  ),
  '{risk,liquidityBufferAtr}',
  '0.25'::jsonb,
  true
),
updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';
