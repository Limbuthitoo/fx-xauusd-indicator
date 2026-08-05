UPDATE app_settings
SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{pollSeconds}', '300'::jsonb, true),
    updated_at = now()
WHERE key = 'feed.provider';

UPDATE tenant_settings
SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{pollSeconds}', '300'::jsonb, true),
    updated_at = now()
WHERE key = 'feed.provider';
