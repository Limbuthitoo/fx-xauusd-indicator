UPDATE platform_strategy_modules
SET name = 'Module 2: All-Session Liquidity Sweep',
    description = 'Automated XAUUSD all-session liquidity sweep confirmation profiles with independent variants, paper trading, checklist, alerts, reports, and learning.',
    updated_at = now()
WHERE code = 'high_probability_strategy_2';

UPDATE strategies
SET name = replace(name, 'New York', 'All-Session'),
    description = 'All-session XAUUSD liquidity sweep execution module: one paper-approved confirmation profile can create BUY/SELL, paper trade, notification, and journal entries after risk approval.'
WHERE id IN (
  SELECT strategy_id
  FROM strategy_versions
  WHERE configuration_json->>'moduleCode' = 'high_probability_strategy_2'
);

UPDATE strategy_versions
SET session_start = '00:00',
    trade_window_end = '23:59',
    configuration_json = jsonb_set(
      jsonb_set(
        COALESCE(configuration_json, '{}'::jsonb),
        '{newYorkStartTime}',
        '"00:00"'::jsonb,
        true
      ),
      '{newYorkEndTime}',
      '"23:59"'::jsonb,
      true
    )
WHERE configuration_json->>'moduleCode' = 'high_probability_strategy_2';

UPDATE tenant_module_settings
SET value = jsonb_set(
      jsonb_set(
        COALESCE(value, '{}'::jsonb),
        '{newYorkStartTime}',
        '"00:00"'::jsonb,
        true
      ),
      '{newYorkEndTime}',
      '"23:59"'::jsonb,
      true
    ),
    updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';

UPDATE trading_sessions
SET session_start_at = date_trunc('day', session_start_at AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York',
    opening_range_end_at = date_trunc('day', session_start_at AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York',
    signal_window_end_at = (date_trunc('day', session_start_at AT TIME ZONE 'America/New_York') + interval '23 hours 59 minutes') AT TIME ZONE 'America/New_York',
    state = CASE WHEN state = 'SESSION_EXPIRED' THEN 'WAITING_FOR_SETUP' ELSE state END
WHERE module_code = 'high_probability_strategy_2'
  AND state NOT IN ('TRADE_CLOSED', 'SESSION_COMPLETED');
