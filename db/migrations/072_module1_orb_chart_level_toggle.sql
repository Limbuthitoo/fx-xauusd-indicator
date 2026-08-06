UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
  COALESCE(sv.configuration_json, '{}'::jsonb)
    || jsonb_build_object('chart', COALESCE(sv.configuration_json->'chart', '{}'::jsonb)),
  '{chart,showOrbSessionLevels}',
  COALESCE(sv.configuration_json #> '{chart,showOrbSessionLevels}', 'true'::jsonb),
  true
)
FROM strategies s
JOIN strategy_sources src ON src.id = s.source_id
WHERE s.id = sv.strategy_id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode') = 'orb_max_options';

UPDATE tenant_module_settings
SET
  value = jsonb_set(
    COALESCE(value, '{}'::jsonb)
      || jsonb_build_object('chart', COALESCE(value->'chart', '{}'::jsonb)),
    '{chart,showOrbSessionLevels}',
    COALESCE(value #> '{chart,showOrbSessionLevels}', 'true'::jsonb),
    true
  ),
  updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';

UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
  COALESCE(sv.configuration_json, '{}'::jsonb)
    || jsonb_build_object('chart', COALESCE(sv.configuration_json->'chart', '{}'::jsonb)),
  '{chart,showHorizontalRange}',
  COALESCE(sv.configuration_json #> '{chart,showHorizontalRange}', 'true'::jsonb),
  true
)
FROM strategies s
JOIN strategy_sources src ON src.id = s.source_id
WHERE s.id = sv.strategy_id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode') = 'orb_max_options';

UPDATE tenant_module_settings
SET
  value = jsonb_set(
    COALESCE(value, '{}'::jsonb)
      || jsonb_build_object('chart', COALESCE(value->'chart', '{}'::jsonb)),
    '{chart,showHorizontalRange}',
    COALESCE(value #> '{chart,showHorizontalRange}', 'true'::jsonb),
    true
  ),
  updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';
