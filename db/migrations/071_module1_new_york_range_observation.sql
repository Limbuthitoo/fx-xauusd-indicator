UPDATE strategy_sources
SET
  strategy_name = 'New York XAUUSD ORB MAX',
  market_originally_observed = 'XAUUSD New York session',
  metadata = COALESCE(metadata, '{}'::jsonb)
    || '{"moduleCode":"orb_max_options","runtime":"NEW_YORK_SESSION","sessionPresets":["NEW_YORK_ORB"],"disclaimer":"Backtest required before real-money use."}'::jsonb
WHERE metadata->>'moduleCode' = 'orb_max_options'
   OR id = '00000000-0000-0000-0000-000000000201';

UPDATE strategies
SET
  name = 'New York XAUUSD ORB MAX',
  description = 'Module 1 ORB strategy for the New York session opening range with 5-minute confirmation triggers and NY-only horizontal range observation.'
WHERE id = '00000000-0000-0000-0000-000000000301'
   OR source_id IN (SELECT id FROM strategy_sources WHERE metadata->>'moduleCode' = 'orb_max_options');

UPDATE strategy_versions sv
SET
  configuration_json = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(sv.configuration_json, '{}'::jsonb),
          '{runtime}',
          '"NEW_YORK_SESSION"'::jsonb,
          true
        ),
        '{sessionPresets}',
        '["NEW_YORK_ORB"]'::jsonb,
        true
      ),
      '{rangeEngine,horizontalRange,enabled}',
      'true'::jsonb,
      true
    ),
    '{rangeEngine,horizontalRange,scope}',
    '"NEW_YORK_SESSION_ONLY"'::jsonb,
    true
  ),
  session_start = '09:15',
  trade_window_end = '16:00',
  opening_range_minutes = 15,
  signal_timeframe_minutes = 5,
  activated_at = now()
FROM strategies s
JOIN strategy_sources src ON src.id = s.source_id
WHERE s.id = sv.strategy_id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode') = 'orb_max_options';

UPDATE tenant_module_settings
SET
  value = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(value, '{}'::jsonb),
          '{runtime}',
          '"NEW_YORK_SESSION"'::jsonb,
          true
        ),
        '{sessionPresets}',
        '["NEW_YORK_ORB"]'::jsonb,
        true
      ),
      '{rangeEngine,horizontalRange,enabled}',
      'true'::jsonb,
      true
    ),
    '{rangeEngine,horizontalRange,scope}',
    '"NEW_YORK_SESSION_ONLY"'::jsonb,
    true
  ),
  description = 'Tenant-level New York ORB MAX thresholds, NY-only horizontal observation, and automatic paper-trade rules.',
  updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';

UPDATE tenant_automation_states
SET
  latest_reason = 'Module 1 New York ORB automation and horizontal range observation are ready.',
  updated_at = now()
WHERE module_code = 'orb_max_options';
