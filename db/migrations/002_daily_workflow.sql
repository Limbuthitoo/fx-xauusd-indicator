CREATE TABLE IF NOT EXISTS pre_session_readiness (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES trading_sessions(id) ON DELETE CASCADE,
  item_code TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT 'UNCERTAIN',
  mandatory BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, item_code)
);

CREATE INDEX IF NOT EXISTS trading_sessions_daily_lookup_idx
ON trading_sessions(symbol, strategy_version_id, session_date, session_preset);
