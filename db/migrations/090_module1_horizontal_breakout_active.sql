UPDATE strategy_versions
SET configuration_json = jsonb_set(
      jsonb_set(
        COALESCE(configuration_json, '{}'::jsonb),
        '{rangeEngine,horizontalRange,observationOnly}',
        'false'::jsonb,
        true
      ),
      '{rangeEngine,horizontalRange,signalMode}',
      '"ACTIVE_SIGNAL"'::jsonb,
      true
    ),
    activated_at = now()
WHERE status = 'ACTIVE'
  AND configuration_json->>'moduleCode' = 'orb_max_options';

UPDATE tenant_module_settings
SET value = jsonb_set(
      jsonb_set(
        COALESCE(value, '{}'::jsonb),
        '{rangeEngine,horizontalRange,observationOnly}',
        'false'::jsonb,
        true
      ),
      '{rangeEngine,horizontalRange,signalMode}',
      '"ACTIVE_SIGNAL"'::jsonb,
      true
    ),
    description = 'Module 1 New York ORB plus active full-session horizontal breakout/retest signal profile.',
    updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';

COMMENT ON TABLE ranges IS
  'Persistent ORB and horizontal-range lifecycle state used by Module 1 breakout and retest evaluation.';
