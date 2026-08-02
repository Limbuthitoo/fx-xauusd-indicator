UPDATE app_settings
SET value = '5'::jsonb,
    updated_at = now()
WHERE key = 'trading.timeframeMinutes';

UPDATE tenant_settings
SET value = '5'::jsonb,
    updated_at = now()
WHERE key = 'trading.timeframeMinutes';

UPDATE strategy_versions sv
SET signal_timeframe_minutes = 5,
    configuration_json = jsonb_set(
      COALESCE(configuration_json, '{}'::jsonb),
      '{signalTimeframeMinutes}',
      '5'::jsonb,
      true
    )
FROM strategies s
LEFT JOIN strategy_sources src ON src.id = s.source_id
WHERE sv.strategy_id = s.id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') = 'orb_max_options';

UPDATE tenant_automation_states
SET timeframe_minutes = 5,
    updated_at = now()
WHERE module_code = 'orb_max_options';
