CREATE TABLE IF NOT EXISTS operational_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  severity TEXT NOT NULL DEFAULT 'INFO',
  category TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  request_id TEXT,
  route TEXT,
  method TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  tenant_id UUID,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operational_events_created_idx
  ON operational_events (created_at DESC);

CREATE INDEX IF NOT EXISTS operational_events_category_created_idx
  ON operational_events (category, created_at DESC);

CREATE INDEX IF NOT EXISTS operational_events_severity_created_idx
  ON operational_events (severity, created_at DESC);
