CREATE TABLE IF NOT EXISTS module_session_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  session_id UUID REFERENCES trading_sessions(id) ON DELETE SET NULL,
  session_date DATE NOT NULL,
  final_status TEXT NOT NULL CHECK (final_status IN ('GO', 'NO_GO', 'REVIEW')),
  summary JSONB NOT NULL DEFAULT '{}',
  feed_snapshot JSONB NOT NULL DEFAULT '{}',
  setup_snapshot JSONB NOT NULL DEFAULT '{}',
  trade_snapshot JSONB NOT NULL DEFAULT '{}',
  blocked_reasons JSONB NOT NULL DEFAULT '[]',
  checklist_summary JSONB NOT NULL DEFAULT '{}',
  learning_notes JSONB NOT NULL DEFAULT '{}',
  operator_notes TEXT,
  trusted_manually BOOLEAN,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module_code, session_date)
);

CREATE INDEX IF NOT EXISTS module_session_reports_tenant_module_idx
  ON module_session_reports(tenant_id, module_code, session_date DESC);
