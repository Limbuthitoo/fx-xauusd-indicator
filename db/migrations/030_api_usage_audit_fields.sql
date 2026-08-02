ALTER TABLE api_usage_events
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN IF NOT EXISTS usage_reason TEXT,
  ADD COLUMN IF NOT EXISTS forced BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS api_usage_events_trigger_idx
  ON api_usage_events (provider, trigger_source, created_at DESC);
