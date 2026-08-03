UPDATE app_settings
SET value = jsonb_set(
  COALESCE(value, '{}'::jsonb),
  '{sessionStart}',
  '"09:15"'::jsonb,
  true
)
WHERE key = 'orb.session'
  AND COALESCE(value->>'sessionStart', '09:30') = '09:30';

UPDATE tenant_settings
SET value = jsonb_set(
  COALESCE(value, '{}'::jsonb),
  '{sessionStart}',
  '"09:15"'::jsonb,
  true
)
WHERE key = 'orb.session'
  AND COALESCE(value->>'sessionStart', '09:30') = '09:30';

UPDATE strategy_versions sv
SET session_start = '09:15',
    configuration_json = jsonb_set(
      COALESCE(configuration_json, '{}'::jsonb),
      '{sessionStart}',
      '"09:15"'::jsonb,
      true
    )
FROM strategies st
JOIN strategy_sources src ON src.id = st.source_id
WHERE sv.strategy_id = st.id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') = 'orb_max_options'
  AND sv.session_start = '09:30';

WITH shifted_sessions AS (
  UPDATE trading_sessions
  SET session_start_at = session_start_at - interval '15 minutes',
      opening_range_end_at = opening_range_end_at - interval '15 minutes',
      session_preset = 'NY_0915'
  WHERE module_code = 'orb_max_options'
    AND session_preset = 'NY_0930'
    AND state IN ('PRE_SESSION', 'OPENING_RANGE_FORMING', 'OPENING_RANGE_LOCKED', 'WAITING_FOR_SETUP', 'SESSION_EXPIRED')
    AND session_date >= ((now() AT TIME ZONE 'America/New_York')::date - 1)
  RETURNING id
)
DELETE FROM opening_ranges orr
USING shifted_sessions ss
WHERE orr.session_id = ss.id;

UPDATE user_preferences
SET selected_session_preset = 'NY_0915'
WHERE selected_session_preset = 'NY_0930';
