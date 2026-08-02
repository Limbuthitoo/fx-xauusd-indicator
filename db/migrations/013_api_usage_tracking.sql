CREATE TABLE IF NOT EXISTS api_usage_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  symbol TEXT,
  timeframe_minutes INTEGER,
  requested_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 1,
  tenant_count INTEGER NOT NULL DEFAULT 1,
  tenant_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_usage_events_provider_day_idx
  ON api_usage_events(provider, created_at DESC);

CREATE INDEX IF NOT EXISTS api_usage_events_symbol_idx
  ON api_usage_events(symbol, timeframe_minutes, created_at DESC);
