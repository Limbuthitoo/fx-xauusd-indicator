UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(configuration_json, '{}'::jsonb),
          '{openingRangeTimeframe}',
          '15'::jsonb,
          true
        ),
        '{executionTimeframe}',
        '5'::jsonb,
        true
      ),
      '{signalTimeframeMinutes}',
      '5'::jsonb,
      true
    ),
    signal_timeframe_minutes = 5
FROM strategies s
LEFT JOIN strategy_sources src ON src.id = s.source_id
WHERE sv.strategy_id = s.id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') = 'orb_max_options';

UPDATE tenant_module_settings
SET value = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(value, '{}'::jsonb),
          '{openingRangeTimeframe}',
          '15'::jsonb,
          true
        ),
        '{executionTimeframe}',
        '5'::jsonb,
        true
      ),
      '{signalTimeframeMinutes}',
      '5'::jsonb,
      true
    ),
    updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';

UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
      jsonb_set(
        COALESCE(configuration_json, '{}'::jsonb),
        '{setupTimeframe}',
        '5'::jsonb,
        true
      ),
      '{biasTimeframe}',
      '15'::jsonb,
      true
    ),
    signal_timeframe_minutes = 5
FROM strategies s
LEFT JOIN strategy_sources src ON src.id = s.source_id
WHERE sv.strategy_id = s.id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') IN ('high_probability_strategy_2', 'strategy_lab_3');

UPDATE tenant_module_settings
SET value = jsonb_set(
      jsonb_set(
        COALESCE(value, '{}'::jsonb),
        '{setupTimeframe}',
        '5'::jsonb,
        true
      ),
      '{biasTimeframe}',
      '15'::jsonb,
      true
    ),
    updated_at = now()
WHERE (module_code = 'high_probability_strategy_2' AND key = 'liquiditySweep.strategy')
   OR (module_code = 'strategy_lab_3' AND key = 'vwapOpeningDrive.strategy');
