ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS provider_code TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS provider_price_id TEXT,
  ADD COLUMN IF NOT EXISTS checkout_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE tenant_subscriptions
  ADD COLUMN IF NOT EXISTS provider_code TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS provider_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS latest_invoice_id UUID,
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS subscription_checkout_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id),
  subscription_id UUID REFERENCES tenant_subscriptions(id) ON DELETE SET NULL,
  provider_code TEXT NOT NULL DEFAULT 'manual',
  provider_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  mode TEXT NOT NULL DEFAULT 'SUBSCRIPTION',
  amount_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  checkout_url TEXT,
  expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES tenant_subscriptions(id) ON DELETE SET NULL,
  plan_id UUID REFERENCES subscription_plans(id) ON DELETE SET NULL,
  provider_code TEXT NOT NULL DEFAULT 'manual',
  provider_invoice_id TEXT,
  invoice_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  amount_due_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  amount_paid_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  hosted_invoice_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_checkout_sessions_tenant_idx ON subscription_checkout_sessions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_checkout_sessions_status_idx ON subscription_checkout_sessions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_invoices_tenant_idx ON subscription_invoices(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_invoices_status_idx ON subscription_invoices(status, due_at DESC);

UPDATE tenant_subscriptions
SET
  current_period_start = COALESCE(current_period_start, starts_at),
  current_period_end = COALESCE(current_period_end, renews_at)
WHERE current_period_start IS NULL OR current_period_end IS NULL;
