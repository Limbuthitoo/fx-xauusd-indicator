CREATE TABLE IF NOT EXISTS setup_candle_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  setup_candidate_id UUID NOT NULL REFERENCES setup_candidates(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES trading_sessions(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL REFERENCES instruments(symbol),
  timeframe_minutes INTEGER NOT NULL,
  timestamp_utc TIMESTAMPTZ NOT NULL,
  open NUMERIC(18, 5) NOT NULL,
  high NUMERIC(18, 5) NOT NULL,
  low NUMERIC(18, 5) NOT NULL,
  close NUMERIC(18, 5) NOT NULL,
  volume NUMERIC(18, 4),
  spread NUMERIC(18, 5),
  source TEXT NOT NULL DEFAULT 'SNAPSHOT',
  candle_role TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(setup_candidate_id, timestamp_utc),
  CHECK (candle_role IN ('OPENING_RANGE', 'PRE_SIGNAL', 'SIGNAL')),
  CHECK (high >= low),
  CHECK (high >= open AND high >= close),
  CHECK (low <= open AND low <= close),
  CHECK (open > 0 AND high > 0 AND low > 0 AND close > 0)
);

CREATE INDEX IF NOT EXISTS setup_candle_snapshots_setup_idx
  ON setup_candle_snapshots(setup_candidate_id, timestamp_utc);

CREATE INDEX IF NOT EXISTS setup_candle_snapshots_session_idx
  ON setup_candle_snapshots(session_id, timestamp_utc);
