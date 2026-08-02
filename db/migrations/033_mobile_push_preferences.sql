ALTER TABLE mobile_push_tokens
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{
    "nyPreSession": true,
    "validEntries": true,
    "paperTradeOpened": true,
    "takeProfitStopLoss": true,
    "dailyReports": true,
    "weeklyMonthlyReports": true,
    "learningReviews": false,
    "systemDiagnostics": false
  }'::jsonb;
