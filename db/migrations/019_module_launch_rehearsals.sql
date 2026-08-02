CREATE TABLE IF NOT EXISTS module_launch_rehearsals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  final_status TEXT NOT NULL CHECK (final_status IN ('GO', 'NO_GO')),
  checklist_json JSONB NOT NULL DEFAULT '[]',
  health_json JSONB NOT NULL DEFAULT '{}',
  audit_json JSONB NOT NULL DEFAULT '{}',
  dry_run_json JSONB NOT NULL DEFAULT '{}',
  handoff_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS module_launch_rehearsals_tenant_module_idx
  ON module_launch_rehearsals(tenant_id, module_code, created_at DESC);
