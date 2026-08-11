UPDATE platform_strategy_modules
SET name = CASE code
      WHEN 'orb_max_options' THEN 'Module 1: New York ORB MAX Strategy'
      WHEN 'high_probability_strategy_2' THEN 'Module 2: New York Ultimate Liquidity Sweep'
      ELSE name
    END,
    description = CASE code
      WHEN 'orb_max_options' THEN 'Automated XAUUSD New York 15-minute opening range with 5-minute ORB and horizontal-range signal profiles, BUY/SELL alerts, predictions, and paper tracking.'
      WHEN 'high_probability_strategy_2' THEN 'Automated XAUUSD New York liquidity-sweep confirmation profiles using completed 5-minute candles, BUY/SELL alerts, predictions, and paper tracking.'
      ELSE description
    END,
    updated_at = now()
WHERE code IN ('orb_max_options', 'high_probability_strategy_2');

UPDATE strategies
SET name = CASE
      WHEN id IN (
        SELECT strategy_id FROM strategy_versions
        WHERE configuration_json->>'moduleCode' = 'orb_max_options'
      ) THEN 'New York XAUUSD ORB MAX'
      ELSE 'New York XAUUSD Ultimate Liquidity Sweep'
    END,
    description = CASE
      WHEN id IN (
        SELECT strategy_id FROM strategy_versions
        WHERE configuration_json->>'moduleCode' = 'orb_max_options'
      ) THEN 'New York-only 15-minute opening range and horizontal-range profiles with completed 5-minute entry triggers.'
      ELSE 'New York-only liquidity sweep profiles with completed 5-minute execution and 15-minute context.'
    END
WHERE id IN (
  SELECT strategy_id FROM strategy_versions
  WHERE configuration_json->>'moduleCode' IN ('orb_max_options', 'high_probability_strategy_2')
);

UPDATE strategy_versions
SET session_start = CASE WHEN configuration_json->>'moduleCode' = 'orb_max_options' THEN '09:15' ELSE '09:30' END,
    trade_window_end = '16:00',
    signal_timeframe_minutes = 5,
    configuration_json = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(configuration_json, '{}'::jsonb),
          '{runtime}',
          '"NEW_YORK_SESSION"'::jsonb,
          true
        ),
        '{newYorkStartTime}',
        CASE WHEN configuration_json->>'moduleCode' = 'orb_max_options' THEN '"09:15"'::jsonb ELSE '"09:30"'::jsonb END,
        true
      ),
      '{newYorkEndTime}',
      '"16:00"'::jsonb,
      true
    )
WHERE configuration_json->>'moduleCode' IN ('orb_max_options', 'high_probability_strategy_2');

UPDATE tenant_module_settings
SET value = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(value, '{}'::jsonb),
          '{runtime}',
          '"NEW_YORK_SESSION"'::jsonb,
          true
        ),
        '{newYorkStartTime}',
        CASE WHEN module_code = 'orb_max_options' THEN '"09:15"'::jsonb ELSE '"09:30"'::jsonb END,
        true
      ),
      '{newYorkEndTime}',
      '"16:00"'::jsonb,
      true
    ),
    description = CASE
      WHEN module_code = 'orb_max_options' THEN 'Tenant-level New York ORB and horizontal-range signal settings.'
      ELSE 'Tenant-level New York liquidity-sweep profile and risk settings.'
    END,
    updated_at = now()
WHERE module_code IN ('orb_max_options', 'high_probability_strategy_2')
  AND key IN ('orb.strategy', 'liquiditySweep.strategy');

UPDATE tenant_automation_states
SET latest_reason = CASE module_code
      WHEN 'orb_max_options' THEN 'Module 1 New York ORB monitoring is scheduled.'
      ELSE 'Module 2 New York liquidity-sweep monitoring is scheduled.'
    END,
    updated_at = now()
WHERE module_code IN ('orb_max_options', 'high_probability_strategy_2');
