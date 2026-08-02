CREATE TABLE IF NOT EXISTS module_tuning_promotions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('APPLY_PRESET', 'ROLLBACK')),
  preset_code TEXT NOT NULL,
  previous_value JSONB NOT NULL,
  applied_value JSONB NOT NULL,
  tuning_summary JSONB NOT NULL DEFAULT '{}',
  safety_checks JSONB NOT NULL DEFAULT '[]',
  qa_only BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  applied_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS module_tuning_promotions_tenant_module_idx
  ON module_tuning_promotions(tenant_id, module_code, applied_at DESC);
