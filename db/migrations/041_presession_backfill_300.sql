UPDATE app_settings
SET value = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(COALESCE(value, '{}'::jsonb), '{name}', '"TWELVE_DATA"'::jsonb, true),
          '{rawCandleStorage}',
          'true'::jsonb,
          true
        ),
        '{cacheDays}',
        '7'::jsonb,
        true
      ),
      '{startupBackfillCount}',
      '300'::jsonb,
      true
    ),
    updated_at = now()
WHERE key = 'feed.provider';

UPDATE tenant_settings
SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{startupBackfillCount}', '300'::jsonb, true),
    updated_at = now()
WHERE key = 'feed.provider'
  AND COALESCE((value->>'startupBackfillCount')::int, 0) < 300;
