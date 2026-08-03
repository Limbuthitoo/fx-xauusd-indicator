CREATE INDEX IF NOT EXISTS candles_source_retention_idx
  ON candles (symbol, timeframe_minutes, timestamp_utc)
  WHERE source LIKE 'TWELVE_DATA%';
