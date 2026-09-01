INSERT INTO economic_calendar_sync_state (provider, enabled, status, metadata)
VALUES (
  'OFFICIAL_US',
  true,
  'NOT_READY',
  '{"message":"Awaiting the first synchronization from the official BLS, BEA, Census, and Federal Reserve schedules."}'::jsonb
)
ON CONFLICT (provider) DO UPDATE SET
  enabled = true,
  updated_at = now();
