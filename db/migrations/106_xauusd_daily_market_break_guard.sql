ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS close_reason TEXT;

DELETE FROM candles
WHERE replace(upper(symbol), '/', '') = 'XAUUSD'
  AND source LIKE 'TWELVE_DATA%'
  AND (
    extract(isodow FROM timestamp_utc AT TIME ZONE 'America/New_York') = 6
    OR (
      extract(isodow FROM timestamp_utc AT TIME ZONE 'America/New_York') = 7
      AND (timestamp_utc AT TIME ZONE 'America/New_York')::time < time '18:00'
    )
    OR (
      extract(isodow FROM timestamp_utc AT TIME ZONE 'America/New_York') BETWEEN 1 AND 4
      AND (timestamp_utc AT TIME ZONE 'America/New_York')::time >= time '17:00'
      AND (timestamp_utc AT TIME ZONE 'America/New_York')::time < time '18:00'
    )
    OR (
      extract(isodow FROM timestamp_utc AT TIME ZONE 'America/New_York') = 5
      AND (timestamp_utc AT TIME ZONE 'America/New_York')::time >= time '17:00'
    )
  );

CREATE INDEX IF NOT EXISTS trades_close_reason_idx
  ON trades (close_reason, closed_at DESC)
  WHERE close_reason IS NOT NULL;

COMMENT ON COLUMN trades.close_reason IS
  'Canonical paper-trade exit reason, including MARKET_BREAK_EXIT for controlled intraday metals closeout.';
