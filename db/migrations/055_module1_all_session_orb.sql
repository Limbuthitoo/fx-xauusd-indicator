UPDATE platform_strategy_modules
SET name = 'Module 1: All-Session ORB MAX Strategy',
    description = 'Automated XAUUSD ORB checklist across Sydney, Tokyo, London, and New York sessions with 15-minute opening ranges, 5-minute triggers, paper trading, journal, reports, and learning recommendations.',
    target_win_rate = 'Rules-first, session-by-session backtest required',
    updated_at = now()
WHERE code = 'orb_max_options';

UPDATE strategies
SET name = 'All-Session XAUUSD ORB MAX'
WHERE name IN ('Max-Inspired XAUUSD NY ORB', 'Max-Inspired XAUUSD New York ORB')
   OR name ILIKE '%XAUUSD%NY%ORB%';

UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(configuration_json, '{}'::jsonb),
          '{moduleRuntime}',
          '"ALL_SESSIONS"',
          true
        ),
        '{sessionPresets}',
        '["SYDNEY_ORB","TOKYO_ORB","LONDON_ORB","NEW_YORK_ORB"]'::jsonb,
        true
      ),
      '{signalTimeframeMinutes}',
      '5'::jsonb,
      true
    ),
    opening_range_minutes = 15,
    signal_timeframe_minutes = 5
FROM strategies st
JOIN strategy_sources src ON src.id = st.source_id
WHERE sv.strategy_id = st.id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') = 'orb_max_options';

UPDATE trading_sessions
SET session_preset = 'NEW_YORK_ORB'
WHERE module_code = 'orb_max_options'
  AND session_preset IN ('NY_0915', 'NY_0930');
