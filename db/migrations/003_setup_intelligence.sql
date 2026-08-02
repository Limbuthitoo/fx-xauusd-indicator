ALTER TABLE setup_candidates
  ADD COLUMN IF NOT EXISTS favorability_score INTEGER,
  ADD COLUMN IF NOT EXISTS favorability_grade TEXT,
  ADD COLUMN IF NOT EXISTS favorability_reasons JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS scenario_flags JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS setup_favorability_idx
ON setup_candidates(symbol, favorability_score, detected_at);

UPDATE strategy_versions
SET configuration_json = configuration_json
  || '{
    "favorability":{
      "minimumScoreForPaperTrade":70,
      "minimumTrendLookbackCandles":50,
      "preferredSpreadPercentOfRange":0.12,
      "minimumAtrPercentOfRange":0.4
    },
    "paperTrading":{"enabled":true,"maximumTradesPerSession":1,"conservativeSameCandleExit":true},
    "execution":{"mode":"PAPER_ONLY","manualConfirmationRequired":false}
  }'::jsonb
WHERE status = 'ACTIVE';
