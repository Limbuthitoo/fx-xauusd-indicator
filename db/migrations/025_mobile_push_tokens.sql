CREATE TABLE IF NOT EXISTS mobile_push_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  expo_push_token TEXT NOT NULL,
  platform TEXT,
  device_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, expo_push_token)
);

CREATE INDEX IF NOT EXISTS mobile_push_tokens_tenant_enabled_idx
  ON mobile_push_tokens(tenant_id, enabled, last_seen_at DESC);
