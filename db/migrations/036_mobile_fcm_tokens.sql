ALTER TABLE mobile_push_tokens
  ADD COLUMN IF NOT EXISTS fcm_token TEXT,
  ADD COLUMN IF NOT EXISTS push_provider TEXT NOT NULL DEFAULT 'EXPO';

CREATE UNIQUE INDEX IF NOT EXISTS mobile_push_tokens_tenant_fcm_token_idx
  ON mobile_push_tokens(tenant_id, fcm_token)
  WHERE fcm_token IS NOT NULL;
