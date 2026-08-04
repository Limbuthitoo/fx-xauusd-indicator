UPDATE app_settings
SET value = jsonb_set(
  jsonb_set(
    COALESCE(value, '{}'::jsonb),
    '{sessionStart}',
    '"09:15"'::jsonb,
    true
  ),
  '{openingRangeMinutes}',
  '15'::jsonb,
  true
)
WHERE key = 'orb.session';

UPDATE tenant_settings
SET value = jsonb_set(
  jsonb_set(
    COALESCE(value, '{}'::jsonb),
    '{sessionStart}',
    '"09:15"'::jsonb,
    true
  ),
  '{openingRangeMinutes}',
  '15'::jsonb,
  true
)
WHERE key = 'orb.session';

UPDATE strategy_versions sv
SET session_start = '09:15',
    opening_range_minutes = 15,
    signal_timeframe_minutes = 5,
    configuration_json = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(configuration_json, '{}'::jsonb),
          '{sessionStart}',
          '"09:15"'::jsonb,
          true
        ),
        '{openingRangeMinutes}',
        '15'::jsonb,
        true
      ),
      '{signalTimeframeMinutes}',
      '5'::jsonb,
      true
    )
FROM strategies st
JOIN strategy_sources src ON src.id = st.source_id
WHERE sv.strategy_id = st.id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') = 'orb_max_options';

WITH active_orb_sessions AS (
  SELECT id
  FROM trading_sessions
  WHERE module_code = 'orb_max_options'
    AND state IN ('PRE_SESSION', 'OPENING_RANGE_FORMING', 'OPENING_RANGE_LOCKED', 'WAITING_FOR_SETUP', 'SESSION_EXPIRED')
    AND session_date >= ((now() AT TIME ZONE 'America/New_York')::date - 1)
)
DELETE FROM opening_ranges orr
USING active_orb_sessions aos
WHERE orr.session_id = aos.id;
