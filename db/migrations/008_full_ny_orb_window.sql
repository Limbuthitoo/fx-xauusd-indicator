UPDATE app_settings
SET value = jsonb_set(value, '{tradeWindowEnd}', '"16:00"'::jsonb, true),
    updated_at = now()
WHERE key = 'orb.session'
  AND COALESCE(value->>'tradeWindowEnd', '11:30') <> '16:00';

UPDATE strategy_versions
SET trade_window_end = '16:00',
    configuration_json = jsonb_set(configuration_json, '{tradeWindowEnd}', '"16:00"'::jsonb, true)
WHERE trade_window_end <> '16:00'
   OR COALESCE(configuration_json->>'tradeWindowEnd', '') <> '16:00';
