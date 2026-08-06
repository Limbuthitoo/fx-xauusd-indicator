UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(sv.configuration_json, '{}'::jsonb)
              || jsonb_build_object('chart', COALESCE(sv.configuration_json->'chart', '{}'::jsonb)),
            '{chart,showEma}',
            COALESCE(sv.configuration_json #> '{chart,showEma}', 'true'::jsonb),
            true
          ),
          '{chart,showLiquidity}',
          COALESCE(sv.configuration_json #> '{chart,showLiquidity}', 'true'::jsonb),
          true
        ),
        '{chart,showSweep}',
        COALESCE(sv.configuration_json #> '{chart,showSweep}', 'true'::jsonb),
        true
      ),
      '{chart,showEntryZone}',
      COALESCE(sv.configuration_json #> '{chart,showEntryZone}', 'true'::jsonb),
      true
    ),
    '{chart,showDisplacement}',
    COALESCE(sv.configuration_json #> '{chart,showDisplacement}', 'true'::jsonb),
    true
  ),
  '{chart,showBos}',
  COALESCE(sv.configuration_json #> '{chart,showBos}', 'true'::jsonb),
  true
)
FROM strategies s
JOIN strategy_sources src ON src.id = s.source_id
WHERE s.id = sv.strategy_id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode') = 'high_probability_strategy_2';

UPDATE tenant_module_settings
SET
  value = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(value, '{}'::jsonb)
                || jsonb_build_object('chart', COALESCE(value->'chart', '{}'::jsonb)),
              '{chart,showEma}',
              COALESCE(value #> '{chart,showEma}', 'true'::jsonb),
              true
            ),
            '{chart,showLiquidity}',
            COALESCE(value #> '{chart,showLiquidity}', 'true'::jsonb),
            true
          ),
          '{chart,showSweep}',
          COALESCE(value #> '{chart,showSweep}', 'true'::jsonb),
          true
        ),
        '{chart,showEntryZone}',
        COALESCE(value #> '{chart,showEntryZone}', 'true'::jsonb),
        true
      ),
      '{chart,showDisplacement}',
      COALESCE(value #> '{chart,showDisplacement}', 'true'::jsonb),
      true
    ),
    '{chart,showBos}',
    COALESCE(value #> '{chart,showBos}', 'true'::jsonb),
    true
  ),
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';
