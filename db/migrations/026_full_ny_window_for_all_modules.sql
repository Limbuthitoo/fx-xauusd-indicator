UPDATE strategy_versions
SET
  trade_window_end = '16:00',
  configuration_json = jsonb_set(configuration_json, '{newYorkEndTime}', '"16:00"'::jsonb, true)
WHERE id IN (
  '00000000-0000-0000-0000-000000000402',
  '00000000-0000-0000-0000-000000000403'
);

UPDATE tenant_module_settings
SET
  value = jsonb_set(value, '{newYorkEndTime}', '"16:00"'::jsonb, true),
  updated_at = now()
WHERE (module_code = 'high_probability_strategy_2' AND key = 'liquiditySweep.strategy')
   OR false;

UPDATE trading_sessions
SET
  signal_window_end_at = session_start_at + interval '6 hours 30 minutes',
  state = CASE
    WHEN now() <= session_start_at + interval '6 hours 30 minutes'
      AND state = 'SESSION_EXPIRED'
      THEN 'OPENING_RANGE_LOCKED'
    ELSE state
  END
WHERE module_code = 'high_probability_strategy_2'
  AND session_preset = 'NY_SWEEP_BOS'
  AND signal_window_end_at < session_start_at + interval '6 hours 30 minutes'
  AND state NOT IN ('TRADE_CLOSED', 'SESSION_COMPLETED', 'NO_TRADE');

UPDATE tenant_automation_states
SET
  signal_window_end_at = session_start_at + interval '6 hours 30 minutes',
  api_stop_at = session_start_at + interval '6 hours 30 minutes',
  session_state = CASE
    WHEN now() <= session_start_at + interval '6 hours 30 minutes'
      AND session_state = 'SESSION_EXPIRED'
      THEN 'OPENING_RANGE_LOCKED'
    ELSE session_state
  END,
  phase = CASE
    WHEN now() <= session_start_at + interval '6 hours 30 minutes'
      AND phase = 'AFTER_WINDOW'
      THEN 'MONITORING'
    ELSE phase
  END,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND session_start_at IS NOT NULL
  AND signal_window_end_at IS NOT NULL
  AND signal_window_end_at < session_start_at + interval '6 hours 30 minutes';
