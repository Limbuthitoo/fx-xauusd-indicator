CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pid INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_heartbeat_idx
  ON worker_heartbeats (heartbeat_at DESC);
