WITH active_module1_sessions AS (
  SELECT
    ts.id,
    ts.session_date,
    ts.session_start_at,
    ts.opening_range_end_at,
    ts.signal_window_end_at,
    ((ts.session_date::date + time '09:15') AT TIME ZONE 'America/New_York') AS expected_start_at,
    ((ts.session_date::date + time '09:30') AT TIME ZONE 'America/New_York') AS expected_opening_range_end_at,
    ((ts.session_date::date + time '16:00') AT TIME ZONE 'America/New_York') AS expected_signal_window_end_at
  FROM trading_sessions ts
  WHERE ts.module_code = 'orb_max_options'
    AND ts.state NOT IN ('TRADE_CLOSED', 'SESSION_COMPLETED')
    AND ts.session_date >= ((now() AT TIME ZONE 'America/New_York')::date - 1)
),
repaired AS (
  UPDATE trading_sessions ts
  SET session_start_at = active.expected_start_at,
      opening_range_end_at = active.expected_opening_range_end_at,
      signal_window_end_at = active.expected_signal_window_end_at,
      session_preset = 'NY_0915',
      data_status = 'PENDING',
      state = CASE
        WHEN ts.state IN ('TRADE_PLANNED', 'TRADE_ACTIVE') THEN ts.state
        ELSE 'OPENING_RANGE_LOCKED'
      END
  FROM active_module1_sessions active
  WHERE ts.id = active.id
    AND (
      ts.session_start_at <> active.expected_start_at
      OR ts.opening_range_end_at <> active.expected_opening_range_end_at
      OR ts.signal_window_end_at <> active.expected_signal_window_end_at
      OR ts.session_preset <> 'NY_0915'
    )
  RETURNING ts.id
)
DELETE FROM opening_ranges orr
USING repaired
WHERE orr.session_id = repaired.id;
