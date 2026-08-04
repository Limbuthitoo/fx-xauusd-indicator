UPDATE app_settings
SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{startupBackfillCount}', '2016'::jsonb, true),
    updated_at = now()
WHERE key = 'feed.provider'
  AND COALESCE((value->>'startupBackfillCount')::int, 0) < 2016;

UPDATE tenant_settings
SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{startupBackfillCount}', '2016'::jsonb, true),
    updated_at = now()
WHERE key = 'feed.provider'
  AND COALESCE((value->>'startupBackfillCount')::int, 0) < 2016;
