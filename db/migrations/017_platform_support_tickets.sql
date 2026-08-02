CREATE TABLE IF NOT EXISTS platform_support_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  ticket_type TEXT NOT NULL DEFAULT 'GENERAL',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'OPEN',
  title TEXT NOT NULL,
  description TEXT,
  requested_module_code TEXT REFERENCES platform_strategy_modules(code) ON DELETE SET NULL,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_support_tickets_tenant_idx ON platform_support_tickets(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS platform_support_tickets_status_idx ON platform_support_tickets(status, priority, created_at DESC);
