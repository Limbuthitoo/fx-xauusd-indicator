CREATE TABLE IF NOT EXISTS mobile_push_delivery_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  mobile_push_token_id UUID REFERENCES mobile_push_tokens(id) ON DELETE SET NULL,
  event_key TEXT,
  event_type TEXT,
  preference_key TEXT,
  expo_push_token TEXT,
  status TEXT NOT NULL,
  provider_status INTEGER,
  provider_response JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mobile_push_delivery_logs_tenant_created_idx
  ON mobile_push_delivery_logs(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mobile_push_delivery_logs_event_idx
  ON mobile_push_delivery_logs(event_key, event_type);
