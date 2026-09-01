ALTER TABLE economic_events
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS external_event_id TEXT,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS economic_events_provider_external_id_idx
  ON economic_events (provider, external_event_id)
  WHERE external_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS economic_events_provider_seen_idx
  ON economic_events (provider, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS economic_calendar_sync_state (
  provider TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'DISABLED',
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  coverage_start_at TIMESTAMPTZ,
  coverage_end_at TIMESTAMPTZ,
  events_upserted INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO economic_calendar_sync_state (provider, enabled, status, metadata)
VALUES ('MANUAL', true, 'MANUAL', '{"message":"Events are maintained through the authenticated API."}'::jsonb)
ON CONFLICT (provider) DO NOTHING;
