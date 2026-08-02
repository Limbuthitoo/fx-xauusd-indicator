UPDATE strategy_versions
SET signal_timeframe_minutes = 5,
    configuration_json = jsonb_set(configuration_json, '{signalTimeframeMinutes}', '5'::jsonb, true)
WHERE status = 'ACTIVE'
  AND strategy_id IN (
    SELECT id
    FROM strategies
    WHERE name = 'Max-Inspired XAUUSD NY ORB'
  );
