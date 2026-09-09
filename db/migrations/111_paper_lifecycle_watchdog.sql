CREATE TABLE IF NOT EXISTS paper_lifecycle_watchdog_state (
  worker_name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'STARTING'
    CHECK (status IN ('STARTING', 'HEALTHY', 'CAUTION', 'ERROR')),
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  active_trades_checked INTEGER NOT NULL DEFAULT 0,
  candles_replayed INTEGER NOT NULL DEFAULT 0,
  trades_closed INTEGER NOT NULL DEFAULT 0,
  anomaly_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO paper_lifecycle_watchdog_state (worker_name, status, details)
VALUES ('paper-lifecycle-watchdog', 'STARTING', '{"source":"MIGRATION_111"}'::jsonb)
ON CONFLICT (worker_name) DO NOTHING;

COMMENT ON TABLE paper_lifecycle_watchdog_state IS
  'Latest durable worker reconciliation result for chronological paper-trade candle processing and lifecycle integrity checks.';

COMMENT ON COLUMN paper_lifecycle_watchdog_state.candles_replayed IS
  'Completed candles processed strictly after each active trade lifecycle cursor during the latest watchdog run.';
