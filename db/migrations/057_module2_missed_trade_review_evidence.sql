ALTER TABLE module_learning_reviews
  ADD COLUMN IF NOT EXISTS source_key TEXT,
  ADD COLUMN IF NOT EXISTS review_type TEXT NOT NULL DEFAULT 'LEARNING_RECOMMENDATION',
  ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'INSUFFICIENT_EVIDENCE',
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'module_learning_reviews_review_type_check'
  ) THEN
    ALTER TABLE module_learning_reviews
      ADD CONSTRAINT module_learning_reviews_review_type_check
      CHECK (review_type IN ('LEARNING_RECOMMENDATION', 'MISSED_TRADE_BACKTEST'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'module_learning_reviews_classification_check'
  ) THEN
    ALTER TABLE module_learning_reviews
      ADD CONSTRAINT module_learning_reviews_classification_check
      CHECK (classification IN ('PENDING_CLASSIFICATION', 'TRUE_MISSED_TRADE', 'CORRECTLY_SKIPPED', 'TOO_RISKY', 'RULE_TOO_STRICT', 'INSUFFICIENT_EVIDENCE'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS module_learning_reviews_source_key_uidx
  ON module_learning_reviews(tenant_id, module_code, source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS module_learning_reviews_type_idx
  ON module_learning_reviews(tenant_id, module_code, review_type, created_at DESC);
